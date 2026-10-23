import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getAgent, createCommandError } from '../commands/env.js';
import { downloadWithProgress } from '../downloader.js';
import { resolvesWithinRoot } from '../extractor.js';
import { createThrottledStatusUpdater, formatBytes } from '../utils.js';
import { createTransferState } from './state.js';

const ROUTE = '/Admin/Api/FileTransfer';
const MAX_ATTEMPTS = 4;
export const FILE_CONCURRENCY = 4;
const MANIFEST_PAGE_SIZE = 1000;
const DOWNLOAD_ATTEMPTS = 3;

// Exported trees never include these unless --dangerouslyIncludeLogsAndCache, matching
// what the legacy zip export leaves out.
const EXCLUDED_PREFIXES = ['system/log', 'cache.net'];

/**
 * Client for the File Transfer API (`/Admin/Api/FileTransfer`): resumable, checksum
 * verified uploads, streamed downloads and atomic file operations.
 *
 * The command-level operations keep the semantics of the legacy implementation in
 * files.js and folders.js -- the same destinations, skips and output shapes -- so which
 * transfer is used is invisible to scripts apart from `meta.transfer`. What the client
 * learns about remote files (eTag, SHA-256) is kept in the transfer state in ~/.dwc for
 * diff, sync and deploy.
 */
export function createFileTransferClient(env, user) {
    const base = `${env.protocol}://${env.host}${ROUTE}`;
    const state = createTransferState(env);

    /**
     * Sends a request, retrying network failures and errors the server marks as
     * retryable. Mutations carry one Idempotency-Key across all attempts, so a retry
     * can never apply an operation twice.
     */
    async function request(method, route, { query, json, body, headers = {}, idempotent = false, raw = false, okStatuses = [] } = {}) {
        const url = `${base}/${route}${query ? `?${new URLSearchParams(query)}` : ''}`;
        const requestHeaders = { 'Authorization': `Bearer ${user.apiKey}`, ...headers };
        if (json !== undefined) {
            body = JSON.stringify(json);
            requestHeaders['Content-Type'] = 'application/json';
        }
        if (idempotent) {
            requestHeaders['Idempotency-Key'] = crypto.randomUUID();
        }

        for (let attempt = 1; ; attempt++) {
            let res;
            try {
                res = await fetch(url, { method, headers: requestHeaders, body, agent: getAgent(env.protocol) });
            } catch (err) {
                if (attempt < MAX_ATTEMPTS && isTransientNetworkError(err)) {
                    await delay(attempt);
                    continue;
                }
                throw err;
            }

            if (res.ok || okStatuses.includes(res.status)) {
                return raw ? res : await parseJsonSafe(res);
            }

            const error = await parseJsonSafe(res);
            if (attempt < MAX_ATTEMPTS && (error?.retryable === true || res.status === 502 || res.status === 503 || res.status === 504)) {
                await delay(attempt);
                continue;
            }
            throw createCommandError(error?.message || `File Transfer API request failed with HTTP ${res.status}.`, res.status, error);
        }
    }

    // --- entry-level operations (used by sync/deploy and the commands below) ------

    /** @returns {Promise<{exists: boolean, isDirectory: boolean}>} */
    function exists(remotePath) {
        return request('GET', 'entries/exists', { query: { path: toRemotePath(remotePath) } });
    }

    function metadata(remotePath) {
        return request('GET', 'entries/metadata', { query: { path: toRemotePath(remotePath) } });
    }

    async function checksum(remotePath) {
        const result = await request('GET', 'entries/checksum', { query: { path: toRemotePath(remotePath) } });
        // A cache entry only: checksumming a file does not make its version the baseline.
        state.cacheHash(result.path, { eTag: result.eTag, sha256: result.value });
        return result;
    }

    function usage(remotePath) {
        return request('GET', 'entries/usage', { query: { path: toRemotePath(remotePath) } });
    }

    async function* manifest(root) {
        let cursor = null;
        do {
            const page = await request('GET', 'manifest', {
                query: { path: root, pageSize: MANIFEST_PAGE_SIZE, ...(cursor ? { cursor } : {}) }
            });
            yield* page.entries;
            cursor = page.nextCursor;
        } while (cursor);
    }

    /**
     * The whole tree under `remoteRoot`, keyed by lower-cased relative path.
     * @returns {Promise<{files: Map, directories: Map}|null>} null when the root does not exist.
     */
    async function manifestMap(remoteRoot) {
        const root = toRemotePath(remoteRoot);
        const files = new Map();
        const directories = new Map();
        try {
            for await (const entry of manifest(root)) {
                (entry.isDirectory ? directories : files).set(entry.path.toLowerCase(), entry);
            }
        } catch (err) {
            if (err.details?.code === 'NOT_FOUND') return null;
            throw err;
        }
        return { files, directories };
    }

    /**
     * Uploads one file through a resumable, checksum-verified session and records the
     * result in the transfer state. With `ifMatch`, the server only replaces the target
     * if it is still that version.
     */
    async function uploadFile(filePath, targetPath, { overwrite = false, ifMatch, sha256 } = {}) {
        const size = (await fs.promises.stat(filePath)).size;
        sha256 = sha256 ?? await hashFile(filePath);
        let session;
        try {
            session = await request('POST', 'uploads', {
                json: { targetPath, fileSize: size, expectedSha256: sha256 },
                idempotent: true
            });

            const handle = await fs.promises.open(filePath, 'r');
            try {
                for (let index = 0; index < session.totalChunks; index++) {
                    const offset = index * session.chunkSize;
                    const length = Math.min(session.chunkSize, size - offset);
                    const buffer = Buffer.alloc(length);
                    await handle.read(buffer, 0, length, offset);
                    // Chunks are idempotent by construction: a retried PUT just rewrites it.
                    await request('PUT', `uploads/${session.id}/chunks/${index}`, {
                        body: buffer,
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'X-Content-Sha256': crypto.createHash('sha256').update(buffer).digest('hex')
                        }
                    });
                }
            } finally {
                await handle.close();
            }

            const completion = await request('POST', `uploads/${session.id}/finalize`, {
                json: { sha256, overwrite: ifMatch ? false : overwrite },
                headers: ifMatch ? { 'If-Match': ifMatch } : {}
            });
            state.recordFile(completion.targetPath, { eTag: completion.eTag, sha256: completion.sha256, size: completion.size });
            return { chunks: session.totalChunks, completion: { file: filePath, targetPath: completion.targetPath, size: completion.size, sha256: completion.sha256, eTag: completion.eTag } };
        } catch (err) {
            if (session) {
                await request('DELETE', `uploads/${session.id}`).catch(() => { });
            }
            throw err;
        }
    }

    /** Deletes a file or directory tree; a missing path is reported as `false`. */
    async function deleteEntry(remotePath, { ifMatch, recursive = true } = {}) {
        const target = toRemotePath(remotePath);
        try {
            await request('POST', 'entries/delete', {
                json: { path: target, recursive },
                headers: ifMatch ? { 'If-Match': ifMatch } : {},
                idempotent: true
            });
        } catch (err) {
            if (err.details?.code === 'NOT_FOUND') return false;
            throw err;
        }
        state.forget(target);
        return true;
    }

    /** Moves or copies an entry to an exact destination path. */
    async function transferEntry(kind, sourcePath, destinationPath, { overwrite = false } = {}) {
        const source = toRemotePath(sourcePath);
        const entry = await request('POST', `entries/${kind}`, {
            json: { sourcePath: source, destinationPath: toRemotePath(destinationPath), overwrite: Boolean(overwrite) },
            idempotent: true
        });
        if (kind === 'move') state.forget(source);
        return entry;
    }

    function createDirectoryEntry(remotePath) {
        return request('POST', 'entries/directory', { json: { path: toRemotePath(remotePath) }, idempotent: true });
    }

    /**
     * Downloads one file. The partial file is named after the remote version (eTag), so
     * an interrupted download resumes with an HTTP range request -- guarded by If-Range,
     * so a file that changed in the meantime is fetched whole instead of being spliced.
     * With `verify`, the result is checked against the server's SHA-256.
     */
    async function downloadEntry(remotePath, localPath, { eTag, verify = false, realRoot } = {}) {
        if (!eTag) {
            eTag = (await metadata(remotePath)).eTag;
        }
        const partial = `${localPath}.${eTag.replace(/[^0-9a-z-]/gi, '')}.dwpart`;
        if (realRoot) {
            // Writing follows links: an existing link at the file or partial file must
            // not redirect the download outside the destination.
            await assertLocalWithin(realRoot, localPath);
            await assertLocalWithin(realRoot, partial);
        }
        await removeStalePartials(localPath, partial);

        for (let attempt = 1; ; attempt++) {
            const offset = await fileSize(partial);
            const res = await request('GET', 'entries/download', {
                query: { path: remotePath },
                headers: offset > 0 ? { 'Range': `bytes=${offset}-`, 'If-Range': eTag } : {},
                raw: true,
                okStatuses: [416]
            });
            try {
                if (res.status !== 416) {
                    // 206: the server continues where the partial file ends; 200: it sent
                    // the whole file (the version changed, or ranges are not supported).
                    await downloadWithProgress(res, partial, { append: res.status === 206 });
                }
                break;
            } catch (err) {
                // The connection dropped mid-body: the partial file holds what arrived.
                if (attempt >= DOWNLOAD_ATTEMPTS) throw err;
                await delay(attempt);
            }
        }

        await fs.promises.rename(partial, localPath);

        if (verify) {
            const [local, remote] = await Promise.all([hashFile(localPath), checksum(remotePath)]);
            if (local !== remote.value) {
                await fs.promises.rm(localPath, { force: true });
                throw createCommandError(`Checksum mismatch for "${remotePath}": the downloaded file does not match the server's SHA-256.`, 422,
                    { code: 'CHECKSUM_MISMATCH', path: remotePath, expected: remote.value, actual: local });
            }
            return { sha256: local, verified: true };
        }
        return { verified: false };
    }

    // --- listing -------------------------------------------------------------------

    async function list(dirPath, recursive, includeFiles) {
        const root = toRemotePath(dirPath);
        const tree = createDirectoryNode(root);
        try {
            if (recursive) {
                const nodes = new Map([['', tree]]);
                for await (const entry of manifest(root)) {
                    const parent = ensureDirectoryNode(nodes, root, parentOf(entry.path));
                    if (entry.isDirectory) {
                        ensureDirectoryNode(nodes, root, entry.path).modifiedUtc = entry.modifiedUtc;
                    } else if (includeFiles) {
                        addFile(parent, joinRemote(root, entry.path), entry);
                    }
                }
            } else {
                for (const entry of await request('GET', 'entries', { query: { path: root } })) {
                    if (entry.isDirectory) {
                        tree.directories.push({ ...createDirectoryNode(entry.path), modifiedUtc: entry.modifiedUtc });
                    } else if (includeFiles) {
                        addFile(tree, entry.path, entry);
                    }
                }
            }
        } catch (err) {
            throw createCommandError('Unable to fetch file structure.', err.status ?? 1, err.details ?? err.message);
        }
        return tree;
    }

    /** @returns {Promise<boolean|null>} Whether the path is a file, or null when it does not exist. */
    async function isFile(remotePath) {
        const existing = await exists(remotePath);
        return existing.exists ? !existing.isDirectory : null;
    }

    // --- upload --------------------------------------------------------------------

    /**
     * Uploads local files into one remote directory. Like the legacy upload, an existing
     * file is skipped unless `overwrite`, and an empty file is skipped unless `createEmpty`.
     */
    async function uploadFiles(localFilePaths, destinationPath, { createEmpty = false, overwrite = false } = {}, output) {
        const remoteDir = toRemotePath(destinationPath);
        output.log('Uploading files');

        const existing = overwrite ? new Set() : await listFileNames(remoteDir);
        const uploaded = [];
        const skipped = [];
        let chunks = 0;

        try {
            await mapPool(localFilePaths, FILE_CONCURRENCY, async (localFile) => {
                const filePath = path.resolve(localFile);
                const name = path.basename(filePath);
                const size = (await fs.promises.stat(filePath)).size;

                if (size === 0 && !createEmpty) {
                    skipped.push({ file: filePath, reason: 'empty' });
                    output.log(`${filePath} (skipped: empty file)`);
                    return;
                }
                if (existing.has(name.toLowerCase())) {
                    skipped.push({ file: filePath, reason: 'exists' });
                    output.log(`${filePath} (skipped: already exists)`);
                    return;
                }

                let result;
                try {
                    result = await uploadFile(filePath, joinRemote(remoteDir, name), { overwrite });
                } catch (err) {
                    // Someone created the file after we listed the directory: same outcome
                    // as the legacy upload, which silently skips existing files.
                    if (!overwrite && err.details?.code === 'ALREADY_EXISTS') {
                        skipped.push({ file: filePath, reason: 'exists' });
                        output.log(`${filePath} (skipped: already exists)`);
                        return;
                    }
                    throw createCommandError('File upload failed.', err.status ?? 1, err.details ?? { message: err.message, path: joinRemote(remoteDir, name) });
                }
                chunks += result.chunks;
                uploaded.push(result.completion);
                output.log(`${filePath} (${formatBytes(size)})`);
            });
        } finally {
            state.save();
        }

        output.mergeMeta((meta) => ({
            filesProcessed: (meta.filesProcessed || 0) + localFilePaths.length,
            chunks: (meta.chunks || 0) + chunks
        }));
        output.addData({
            type: 'upload',
            destinationPath,
            files: uploaded.map(entry => entry.file),
            skipped,
            results: uploaded
        });
        output.log(`Finished uploading files. Total files: ${localFilePaths.length}, uploaded: ${uploaded.length}, skipped: ${skipped.length}`);
    }

    async function listFileNames(remoteDir) {
        try {
            const entries = await request('GET', 'entries', { query: { path: remoteDir } });
            return new Set(entries.filter(entry => !entry.isDirectory).map(entry => entry.name.toLowerCase()));
        } catch (err) {
            if (err.details?.code === 'NOT_FOUND') return new Set();
            throw createCommandError('File upload failed.', err.status ?? 1, err.details ?? err.message);
        }
    }

    // --- download ------------------------------------------------------------------

    async function downloadFile(remotePath, outPath, output, { verify = false, changedOnly = false } = {}) {
        const remote = toRemotePath(remotePath);
        const filename = path.posix.basename(remote);
        const localPath = path.resolve(outPath, filename);
        output.log(`Downloading file: ${filename}`);
        await fs.promises.mkdir(path.resolve(outPath), { recursive: true });
        const realRoot = await fs.promises.realpath(path.resolve(outPath));

        let skipped = false;
        let result = { verified: false };
        try {
            if (changedOnly && await isSameAsRemote(localPath, remote)) {
                skipped = true;
            } else {
                result = await downloadEntry(remote, localPath, { verify, realRoot });
            }
        } catch (err) {
            throw createCommandError(keepsMessage(err) ? err.message : `Failed to download "${remotePath}".`, err.status ?? 1, err.details ?? err.message);
        }
        state.save();

        output.log(skipped ? `Unchanged, skipped: ${filename}` : `Successfully downloaded: ${filename}`);
        output.addData({
            type: 'download',
            directoryPath: parentOf(remote) || '/',
            filename,
            outPath: path.resolve(outPath),
            recursive: false,
            raw: true,
            skipped,
            verified: result.verified
        });
    }

    /** Whether a local file has the same content as the remote file (size, then SHA-256). */
    async function isSameAsRemote(localPath, remotePath, remoteEntry) {
        const localSize = await fileSize(localPath, -1);
        if (localSize < 0) return false;
        const entry = remoteEntry ?? await metadata(remotePath);
        if (entry.size !== localSize) return false;
        const [local, remote] = await Promise.all([hashFile(localPath), remoteSha256(remotePath, entry.eTag)]);
        return local === remote;
    }

    /** The remote file's SHA-256, from the transfer state when that version's hash is known. */
    async function remoteSha256(remotePath, eTag) {
        return state.knownHash(toRemotePath(remotePath), eTag) ?? (await checksum(remotePath)).value;
    }

    /**
     * Downloads a directory tree file by file into `<outPath>/<directory name>`, the
     * layout the legacy export produces by extracting its zip. The root (`''`) is
     * downloaded straight into `outPath`, like the legacy full export.
     */
    async function downloadDirectory(remotePath, outPath, { includeLogsAndCache = false, verify = false, changedOnly = false } = {}, output) {
        const root = toRemotePath(remotePath);
        const destinationRoot = path.resolve(outPath, root ? path.posix.basename(root) : '');
        output.log('Downloading', root || 'Base', 'Recursive=true');

        const directories = [];
        const files = [];
        try {
            for await (const entry of manifest(root)) {
                if (!includeLogsAndCache && isExcluded(joinRemote(root, entry.path))) continue;
                (entry.isDirectory ? directories : files).push(entry);
            }
        } catch (err) {
            throw createCommandError(`Failed to download "${remotePath}".`, err.status ?? 1, err.details ?? err.message);
        }

        // The output directory itself may be a link (the user chose it); everything the
        // export creates below it must stay inside it on disk.
        await fs.promises.mkdir(path.resolve(outPath), { recursive: true });
        const realOut = await fs.promises.realpath(path.resolve(outPath));
        await assertLocalWithin(realOut, destinationRoot);
        await fs.promises.mkdir(destinationRoot, { recursive: true });
        const realRoot = await fs.promises.realpath(destinationRoot);
        for (const entry of directories) {
            const localDir = localPathFor(destinationRoot, entry.path);
            await assertLocalWithin(realRoot, localDir);
            await fs.promises.mkdir(localDir, { recursive: true });
        }

        const updater = output.json ? null : createThrottledStatusUpdater();
        let done = 0;
        let skipped = 0;
        let bytes = 0;
        try {
            await mapPool(files, FILE_CONCURRENCY, async (entry) => {
                const localPath = localPathFor(destinationRoot, entry.path);
                const remoteFile = joinRemote(root, entry.path);
                await assertLocalWithin(realRoot, path.dirname(localPath));
                await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
                try {
                    if (changedOnly && await isSameAsRemote(localPath, remoteFile, entry)) {
                        skipped++;
                    } else {
                        await downloadEntry(remoteFile, localPath, { eTag: entry.eTag, verify, realRoot });
                        bytes += entry.size;
                    }
                } catch (err) {
                    throw createCommandError(keepsMessage(err) ? err.message : `Failed to download "${remotePath}": "${remoteFile}".`, err.status ?? 1, err.details ?? err.message);
                }
                done++;
                updater?.update(`Downloaded:\t${done} of ${files.length} files (${formatBytes(bytes)})`);
            });
        } finally {
            updater?.stop();
            state.save();
        }

        output.log('Finished downloading', root || '.', 'Recursive=true');
        output.addData({
            type: 'download',
            directoryPath: remotePath ?? '/',
            filename: null,
            outPath: path.resolve(outPath),
            recursive: true,
            raw: false,
            files: files.length,
            skipped,
            verified: verify,
            directories: directories.length,
            bytes
        });
    }

    // --- file operations -----------------------------------------------------------

    /** Deletes a file or directory. Like the legacy delete, a missing path is not an error. */
    async function remove(remotePath, { empty = false } = {}, output) {
        const target = toRemotePath(remotePath);
        const existing = await exists(target);
        const mode = empty ? 'empty' : existing.isDirectory ? 'directory' : 'file';

        if (empty && existing.exists && !existing.isDirectory) {
            throw createCommandError('--empty can only be used with directories.', 400);
        }

        output.log(`${empty ? 'Emptying' : 'Deleting'} ${mode === 'file' ? 'file' : 'directory'}: ${remotePath}`);

        try {
            if (existing.exists && empty) {
                for (const entry of await request('GET', 'entries', { query: { path: target } })) {
                    await deleteEntry(entry.path);
                }
            } else if (existing.exists) {
                await deleteEntry(target);
            }
        } catch (err) {
            throw createCommandError(`Failed to ${empty ? 'empty' : 'delete'} "${remotePath}".`, err.status ?? 1, err.details ?? err.message);
        } finally {
            state.save();
        }

        output.addData({ type: 'delete', path: remotePath, mode, existed: existing.exists, response: null });
        output.log(existing.exists
            ? `Successfully ${empty ? 'emptied' : 'deleted'}: ${remotePath}`
            : `Nothing to ${empty ? 'empty' : 'delete'}, "${remotePath}" does not exist`);
    }

    /** Copies or moves `sourcePath` into the directory `destination`, as the legacy endpoints do. */
    async function copyOrMove(kind, sourcePath, destination, overwrite, output) {
        const source = toRemotePath(sourcePath);
        output.log(`${kind === 'copy' ? 'Copying' : 'Moving'} ${sourcePath} to ${destination}`);

        let entry;
        try {
            entry = await transferEntry(kind, source, joinRemote(toRemotePath(destination), path.posix.basename(source)), { overwrite });
        } catch (err) {
            throw createCommandError(`Failed to ${kind} "${sourcePath}" to "${destination}".`, err.status ?? 1, err.details ?? err.message);
        } finally {
            state.save();
        }

        output.addData({ type: kind, sourcePath, destination, overwrite: Boolean(overwrite), targetPath: entry.path, response: entry });
        output.log(`Successfully ${kind === 'copy' ? 'copied' : 'moved'} ${sourcePath} to ${destination}`);
    }

    async function createDirectory(folderPath, output) {
        output.log(`Creating directory: ${folderPath}`);
        let result;
        try {
            result = await createDirectoryEntry(folderPath);
        } catch (err) {
            throw createCommandError(`Failed to create directory "${folderPath}".`, err.status ?? 1, err.details ?? err.message);
        }
        // The endpoint is idempotent, but the legacy command fails for an existing
        // directory; keep that so a script behaves the same with either transfer.
        if (!result.created) {
            throw createCommandError(`Failed to create directory "${folderPath}".`, 409, { code: 'ALREADY_EXISTS', message: 'A directory with the same name already exists.' });
        }
        output.addData({ type: 'create', path: folderPath, created: true, response: result });
        output.log(`Successfully created: ${folderPath}`);
    }

    async function renameDirectory(folderPath, newName, output) {
        const source = toRemotePath(folderPath);
        output.log(`Renaming directory "${path.posix.basename(source)}" to "${newName}"`);
        let entry;
        try {
            entry = await transferEntry('move', source, joinRemote(parentOf(source), newName));
        } catch (err) {
            throw createCommandError(`Failed to rename "${folderPath}" to "${newName}".`, err.status ?? 1, err.details ?? err.message);
        } finally {
            state.save();
        }
        output.addData({ type: 'rename', path: folderPath, newName, response: entry });
        output.log(`Successfully renamed "${path.posix.basename(source)}" to "${newName}"`);
    }

    async function moveDirectory(sourcePath, destinationPath, output) {
        const source = toRemotePath(sourcePath);
        output.log(`Moving directory "${sourcePath}" to "${destinationPath}"`);
        let entry;
        try {
            entry = await transferEntry('move', source, joinRemote(toRemotePath(destinationPath), path.posix.basename(source)));
        } catch (err) {
            throw createCommandError(`Failed to move "${sourcePath}" to "${destinationPath}".`, err.status ?? 1, err.details ?? err.message);
        } finally {
            state.save();
        }
        output.addData({ type: 'move', sourcePath, destinationPath, response: entry });
        output.log(`Successfully moved "${sourcePath}" to "${destinationPath}"`);
    }

    return {
        name: 'filetransfer',
        state,
        // entry level
        exists,
        metadata,
        checksum,
        usage,
        manifestMap,
        remoteSha256,
        uploadFile,
        deleteEntry,
        moveEntry: (source, destination, options) => transferEntry('move', source, destination, options),
        copyEntry: (source, destination, options) => transferEntry('copy', source, destination, options),
        createDirectoryEntry,
        downloadEntry,
        // command level
        isFile,
        list,
        uploadFiles,
        downloadFile,
        downloadDirectory,
        remove,
        copy: (sourcePath, destination, overwrite, output) => copyOrMove('copy', sourcePath, destination, overwrite, output),
        move: (sourcePath, destination, overwrite, output) => copyOrMove('move', sourcePath, destination, overwrite, output),
        createDirectory,
        renameDirectory,
        moveDirectory
    };
}

/**
 * Converts a CLI path to the File Transfer API's form: relative to the files root, with
 * `/` separators. `''` is the root.
 */
export function toRemotePath(value) {
    const normalized = String(value ?? '').replaceAll('\\', '/').split('/').filter(segment => segment && segment !== '.').join('/');
    return normalized.replace(/^files(\/|$)/i, '');
}

export function joinRemote(...parts) {
    return parts.filter(Boolean).join('/');
}

export function parentOf(remotePath) {
    const index = remotePath.lastIndexOf('/');
    return index < 0 ? '' : remotePath.slice(0, index);
}

export function isExcluded(remotePath) {
    const lower = remotePath.toLowerCase();
    return EXCLUDED_PREFIXES.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`));
}

/**
 * Maps a manifest path onto the local destination, refusing anything that would land
 * outside it. The server validates paths too; this keeps the client safe on its own.
 */
export function localPathFor(destinationRoot, relativePath) {
    const segments = relativePath.split('/');
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes(':'))) {
        throw createCommandError(`Refusing to write unsafe path "${relativePath}" from the server.`, 1);
    }
    const resolved = path.resolve(destinationRoot, ...segments);
    const relative = path.relative(destinationRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw createCommandError(`Refusing to write unsafe path "${relativePath}" from the server.`, 1);
    }
    return resolved;
}

export async function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

/**
 * Runs `fn` over `items`, at most `limit` at a time. After a failure no new item is
 * started, and the first error is only thrown once the running ones have finished, so a
 * caller's cleanup never overlaps work still in flight.
 */
export async function mapPool(items, limit, fn) {
    let next = 0;
    let failure = null;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (!failure && next < items.length) {
            const item = items[next++];
            try {
                await fn(item);
            } catch (err) {
                failure ??= { err };
            }
        }
    });
    await Promise.all(workers);
    if (failure) throw failure.err;
}

function createDirectoryNode(remotePath) {
    return {
        name: remotePath ? path.posix.basename(remotePath) : '/',
        directoryPath: `/Files${remotePath ? `/${remotePath}` : ''}`,
        directories: [],
        files: { totalCount: 0, data: [] }
    };
}

function ensureDirectoryNode(nodes, root, relativePath) {
    if (nodes.has(relativePath)) return nodes.get(relativePath);
    const parent = ensureDirectoryNode(nodes, root, parentOf(relativePath));
    const node = createDirectoryNode(joinRemote(root, relativePath));
    parent.directories.push(node);
    nodes.set(relativePath, node);
    return node;
}

function addFile(directory, remotePath, entry) {
    directory.files.data.push({
        name: entry.name,
        path: `/Files/${remotePath}`,
        size: entry.size,
        modifiedUtc: entry.modifiedUtc,
        eTag: entry.eTag
    });
    directory.files.totalCount = directory.files.data.length;
}

// Checksum mismatches and unsafe local paths are reported as they are, not as a generic
// download failure.
function keepsMessage(err) {
    return err.status === 422 || err.details?.code === 'UNSAFE_LOCAL_PATH';
}

async function assertLocalWithin(realRoot, target) {
    if (!(await resolvesWithinRoot(realRoot, target))) {
        const message = `Refusing to write "${target}": an existing link or junction leads outside "${realRoot}".`;
        throw createCommandError(message, 1, { code: 'UNSAFE_LOCAL_PATH', message, path: target });
    }
}

async function fileSize(filePath, missing = 0) {
    try {
        return (await fs.promises.stat(filePath)).size;
    } catch (err) {
        if (err.code === 'ENOENT') return missing;
        throw err;
    }
}

/** Removes partial downloads of `localPath` left from other remote versions. */
async function removeStalePartials(localPath, keep) {
    const dir = path.dirname(localPath);
    const prefix = `${path.basename(localPath)}.`;
    let names = [];
    try {
        names = await fs.promises.readdir(dir);
    } catch {
        return;
    }
    for (const name of names) {
        const full = path.join(dir, name);
        if (name.startsWith(prefix) && name.endsWith('.dwpart') && full !== keep) {
            await fs.promises.rm(full, { force: true });
        }
    }
}

// Dropped or stalled connections only: a refused connection or an unknown host will not
// fix itself within a few hundred milliseconds.
function isTransientNetworkError(err) {
    return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(err?.code);
}

function delay(attempt) {
    return new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
}

async function parseJsonSafe(res) {
    try {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}
