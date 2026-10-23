import fs from 'fs';
import path from 'path';
import { createCommandError } from '../commands/env.js';
import { FILE_CONCURRENCY, hashFile, joinRemote, mapPool, parentOf, toRemotePath } from './filetransfer.js';

/**
 * Compares a local directory with a remote one and classifies every path:
 *
 *   new          only local
 *   changed      on both, different content
 *   unchanged    on both, same content (size, then SHA-256)
 *   remote-only  only remote (deleted by `sync --delete` and `deploy`)
 *
 * Remote hashes are only fetched for files whose size matches, and come from the
 * transfer state when the remote eTag is the one recorded with them.
 *
 * When the remote root has been synced before, each path that would be overwritten or
 * deleted also gets a `conflict` if it changed on the server since: `modified-remotely`
 * (eTag differs from the recorded one) or `added-remotely` (not recorded at all).
 *
 * @param {Object} client - The File Transfer client.
 * @param {Object} options
 * @param {string} options.localRoot - Local directory (or a single file).
 * @param {string} options.remoteRoot - Remote directory the local root corresponds to.
 * @param {boolean} [options.recursive=true] - Include local subdirectories.
 */
export async function buildPlan(client, { localRoot, remoteRoot, recursive = true }) {
    const remote = toRemotePath(remoteRoot);
    const localAbsolute = path.resolve(localRoot);
    if (!fs.existsSync(localAbsolute)) {
        throw createCommandError(`Local path "${localRoot}" does not exist.`, 404);
    }

    const local = await walkLocal(localAbsolute, recursive);
    const remoteTree = await client.manifestMap(remote) ?? { files: new Map(), directories: new Map() };
    const syncedBefore = client.state.isTracked(remote);
    const items = [];

    const compare = [];
    for (const [key, file] of local.files) {
        const entry = remoteTree.files.get(key);
        const item = { path: file.path, type: 'file', localPath: file.absolute, size: file.size };
        if (!entry) {
            item.action = 'new';
        } else {
            item.remotePath = joinRemote(remote, entry.path);
            item.remoteSize = entry.size;
            item.remoteETag = entry.eTag;
            if (entry.size !== file.size) {
                item.action = 'changed';
            } else {
                compare.push(item);
            }
        }
        items.push(item);
    }

    await mapPool(compare, FILE_CONCURRENCY * 2, async (item) => {
        const [localSha, remoteSha] = await Promise.all([hashFile(item.localPath), client.remoteSha256(item.remotePath, item.remoteETag)]);
        item.sha256 = localSha;
        item.action = localSha === remoteSha ? 'unchanged' : 'changed';
    });

    // Only the remote side of a non-recursive comparison's top level is relevant.
    const inScope = (relative) => recursive || !relative.includes('/');
    for (const [key, entry] of remoteTree.files) {
        if (!local.files.has(key) && inScope(entry.path)) {
            items.push({ path: entry.path, type: 'file', action: 'remote-only', remotePath: joinRemote(remote, entry.path), remoteSize: entry.size, remoteETag: entry.eTag });
        }
    }
    if (recursive) {
        for (const [key, dir] of local.directories) {
            if (!remoteTree.directories.has(key)) {
                items.push({ path: dir.path, type: 'directory', action: 'new', localPath: dir.absolute });
            }
        }
        for (const [key, entry] of remoteTree.directories) {
            if (!local.directories.has(key)) {
                items.push({ path: entry.path, type: 'directory', action: 'remote-only', remotePath: joinRemote(remote, entry.path) });
            }
        }
    }

    if (syncedBefore) {
        for (const item of items) {
            if (item.type !== 'file' || !item.remoteETag || item.action === 'unchanged') continue;
            const recorded = client.state.getFile(item.remotePath);
            if (!recorded) item.conflict = 'added-remotely';
            else if (recorded.eTag !== item.remoteETag) item.conflict = 'modified-remotely';
        }
    }

    items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
        localPath: localAbsolute,
        remotePath: remote,
        remoteExists: remoteTree.files.size > 0 || remoteTree.directories.size > 0 || Boolean(await client.exists(remote).then(r => r.exists)),
        syncedBefore,
        items,
        summary: summarize(items)
    };
}

/** File counts per action, plus directories that only exist on one side. */
export function summarize(items) {
    const files = (action) => items.filter(item => item.type === 'file' && item.action === action).length;
    const directories = (action) => items.filter(item => item.type === 'directory' && item.action === action).length;
    return {
        new: files('new'),
        changed: files('changed'),
        unchanged: files('unchanged'),
        remoteOnly: files('remote-only'),
        conflicts: items.filter(item => item.conflict).length,
        directories: { new: directories('new'), remoteOnly: directories('remote-only') }
    };
}

/**
 * The conflicts that matter for a push: paths it would overwrite, or delete when
 * `deleteRemoteOnly` is set.
 */
export function blockingConflicts(plan, { deleteRemoteOnly = false, overwrite = true } = {}) {
    return plan.items.filter(item => item.conflict && (
        (item.action === 'changed' && overwrite) || (item.action === 'remote-only' && deleteRemoteOnly)
    ));
}

export function assertNoConflicts(conflicts) {
    if (conflicts.length === 0) return;
    const listed = conflicts.slice(0, 10).map(item => `${item.path} (${item.conflict})`).join(', ');
    throw createCommandError(
        `${conflicts.length} file(s) changed on the server since the last sync: ${listed}${conflicts.length > 10 ? ', ...' : ''}. Nothing was changed. Review them, or run without --fail-on-remote-change to overwrite.`,
        409,
        { code: 'REMOTE_CHANGED', conflicts: conflicts.map(({ path: p, conflict, remoteETag }) => ({ path: p, conflict, remoteETag })) }
    );
}

/**
 * Applies a plan to `targetRoot` (normally the plan's remote root; deploy uses a staging
 * copy): uploads new and changed files and, with `deleteRemoteOnly`, removes remote-only
 * paths. With `guard`, overwrites and deletes send If-Match with the planned eTag, so
 * a file changed between planning and applying is not clobbered.
 *
 * @returns {Promise<{ uploaded: Array, deleted: Array, skipped: Array, chunks: number }>}
 */
export async function applyPush(client, plan, { targetRoot = plan.remotePath, deleteRemoteOnly = false, overwrite = true, guard = false, skipEmpty = false } = {}, output) {
    const uploaded = [];
    const skipped = [];
    const deleted = [];
    let chunks = 0;

    const isEmptySkip = (item) => skipEmpty && item.size === 0;
    const uploads = plan.items.filter(item => item.type === 'file' && !isEmptySkip(item) && (item.action === 'new' || (item.action === 'changed' && overwrite)));
    const newDirectories = plan.items.filter(item => item.type === 'directory' && item.action === 'new');
    for (const item of plan.items) {
        if (item.type !== 'file') continue;
        if (isEmptySkip(item) && (item.action === 'new' || item.action === 'changed')) skipped.push({ path: item.path, reason: 'empty' });
        else if (item.action === 'changed' && !overwrite) skipped.push({ path: item.path, reason: 'exists' });
        else if (item.action === 'unchanged') skipped.push({ path: item.path, reason: 'unchanged' });
    }

    try {
        // Uploads create their parent directories; this also brings over empty ones.
        for (const item of newDirectories) {
            await client.createDirectoryEntry(joinRemote(targetRoot, item.path));
        }

        await mapPool(uploads, FILE_CONCURRENCY, async (item) => {
            const target = joinRemote(targetRoot, item.path);
            const ifMatch = guard && item.action === 'changed' && targetRoot === plan.remotePath ? item.remoteETag : undefined;
            try {
                const result = await client.uploadFile(item.localPath, target, { overwrite: !guard || item.action !== 'new', ifMatch, sha256: item.sha256 });
                chunks += result.chunks;
                uploaded.push({ path: item.path, action: item.action, ...result.completion });
                output.log(`${item.action === 'new' ? '+' : '~'} ${item.path}`);
            } catch (err) {
                throw pushError(err, item, 'upload');
            }
        });

        if (deleteRemoteOnly) {
            const removals = plan.items.filter(item => item.action === 'remote-only');
            const guarded = guard && targetRoot === plan.remotePath;
            const remove = async (item, options) => {
                try {
                    await client.deleteEntry(joinRemote(targetRoot, item.path), options);
                } catch (err) {
                    throw await guardedDeleteError(client, err, item, joinRemote(targetRoot, item.path));
                }
                deleted.push({ path: item.path, type: item.type });
                output.log(`- ${item.path}`);
            };

            if (guarded) {
                // Every file goes on its own with If-Match, then the directories, deepest
                // first and non-recursively: a file changed or added after planning is
                // never deleted by way of its directory.
                for (const item of removals.filter(item => item.type === 'file')) {
                    await remove(item, { ifMatch: item.remoteETag });
                }
                const directories = removals.filter(item => item.type === 'directory')
                    .sort((a, b) => b.path.split('/').length - a.path.split('/').length);
                for (const item of directories) {
                    await remove(item, { recursive: false });
                }
            } else {
                // A deleted directory takes its contents with it.
                const directories = removals.filter(item => item.type === 'directory').map(item => `${item.path.toLowerCase()}/`);
                const topLevel = removals.filter(item => !directories.some(dir => item.path.toLowerCase().startsWith(dir)));
                for (const item of topLevel) {
                    await remove(item);
                }
            }
        }
    } finally {
        client.state.save();
    }

    return { uploaded, deleted, skipped, chunks };
}

function pushError(err, item, operation) {
    if (err.details?.code === 'PRECONDITION_FAILED' || err.details?.code === 'ALREADY_EXISTS') {
        return createCommandError(`"${item.path}" changed on the server while the ${operation} was running; it was not overwritten.`, 409,
            { code: 'REMOTE_CHANGED', path: item.path, cause: err.details });
    }
    return createCommandError(`Failed to ${operation} "${item.path}".`, err.status ?? 1, err.details ?? err.message);
}

/**
 * A directory that a non-recursive delete refuses still holds something the plan did
 * not know about: a remote change. Any other failure is reported as it is.
 */
async function guardedDeleteError(client, err, item, target) {
    if (item.type === 'directory') {
        const contents = await client.manifestMap(target).catch(() => null);
        const added = [...(contents?.files.values() ?? []), ...(contents?.directories.values() ?? [])].map(entry => joinRemote(item.path, entry.path));
        if (added.length > 0) {
            return createCommandError(`"${item.path}" holds entries added on the server since planning (${added.slice(0, 10).join(', ')}${added.length > 10 ? ', ...' : ''}); it was not deleted.`, 409,
                { code: 'REMOTE_CHANGED', path: item.path, added, cause: err.details ?? err.message });
        }
    }
    return pushError(err, item, 'delete');
}

/**
 * Updates the baseline of a remote root after a push and marks the root as synced.
 *
 * Only files whose remote content the CLI has verified -- `verified` maps their
 * lower-cased relative path to the SHA-256 and the eTag of the version it was verified
 * for -- become the new baseline, and only while that is still the version on the
 * server: a file edited after it was verified keeps its old baseline. Every other
 * remote file keeps the baseline it had: one changed on the server and left alone (no
 * --overwrite, no --delete) must still count as a remote change next time. Baselines of
 * files that no longer exist are dropped. With `acceptAll`, every remote file is
 * accepted as is (after a rollback, which restores a version the user chose).
 */
export async function recordRemoteRoot(client, plan, verified = new Map(), { acceptAll = false } = {}) {
    const tree = await client.manifestMap(plan.remotePath);
    const present = new Set([...(tree?.files.keys() ?? [])].map(key => joinRemote(plan.remotePath.toLowerCase(), key)));
    for (const recorded of client.state.filesUnder(plan.remotePath)) {
        if (!present.has(recorded)) client.state.forget(recorded);
    }
    for (const [key, entry] of tree?.files ?? []) {
        const known = verified.get(key);
        if (acceptAll || (known && known.eTag === entry.eTag)) {
            client.state.recordFile(joinRemote(plan.remotePath, entry.path), { eTag: entry.eTag, size: entry.size, sha256: known?.sha256 });
        }
    }
    client.state.markRootSynced(plan.remotePath);
    client.state.save();
}

/**
 * Files whose remote content is known to equal the local file after a push: the ones
 * uploaded, and the ones the plan found unchanged by hash. Maps the lower-cased relative
 * path to the SHA-256 and the eTag of the version that hash belongs to.
 */
export function verifiedHashes(plan, uploaded = []) {
    const hashes = new Map();
    for (const item of plan.items) {
        if (item.type === 'file' && item.action === 'unchanged') hashes.set(item.path.toLowerCase(), { sha256: item.sha256, eTag: item.remoteETag });
    }
    for (const item of uploaded) hashes.set(item.path.toLowerCase(), { sha256: item.sha256, eTag: item.eTag });
    return hashes;
}

/**
 * Replaces the remote directory with the local one in one switch-over:
 *
 *   1. copy the current remote directory to a staging directory beside it (on the server)
 *   2. apply the plan to the staging copy (upload changes, delete what local lacks)
 *   3. rename the live directory to a backup and the staging directory into its place
 *   4. delete the backup, unless `keepBackup` (then `rollback` can restore it)
 *
 * The live directory is only touched in step 3: two same-volume renames, milliseconds
 * apart. If the second fails, the first is reverted.
 */
export async function deploy(client, plan, { keepBackup = false } = {}, output) {
    const live = plan.remotePath;
    if (!live) {
        throw createCommandError('Deploying to the root of the file archive is not supported; deploy into a directory.', 400);
    }
    const parent = parentOf(live);
    const name = path.posix.basename(live);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const staging = joinRemote(parent, `${name}.dwdeploy-${stamp}`);
    const backup = joinRemote(parent, `${name}.dwbackup-${stamp}`);

    output.log(`Preparing ${staging}`);
    let push;
    try {
        if (plan.remoteExists) {
            await client.copyEntry(live, staging);
        } else {
            await client.createDirectoryEntry(staging);
        }
        push = await applyPush(client, plan, { targetRoot: staging, deleteRemoteOnly: true, overwrite: true }, output);
    } catch (err) {
        await client.deleteEntry(staging).catch(() => { });
        throw err;
    }

    output.log(`Switching ${live} to the new version`);
    if (plan.remoteExists) {
        try {
            await client.moveEntry(live, backup);
        } catch (err) {
            await client.deleteEntry(staging).catch(() => { });
            throw createCommandError(`Could not move "${live}" aside; nothing was changed.`, err.status ?? 1, err.details ?? err.message);
        }
    }
    try {
        await client.moveEntry(staging, live);
    } catch (err) {
        if (plan.remoteExists) await client.moveEntry(backup, live).catch(() => { });
        await client.deleteEntry(staging).catch(() => { });
        throw createCommandError(`Could not switch "${live}" to the new version; the previous version was restored.`, err.status ?? 1, err.details ?? err.message);
    }

    // Only one backup is kept per directory.
    const previous = client.state.getDeploy(live);
    if (previous?.backupPath) {
        await client.deleteEntry(previous.backupPath).catch(() => { });
    }
    if (plan.remoteExists && !keepBackup) {
        await client.deleteEntry(backup).catch(() => { });
    }
    client.state.setDeploy(live, plan.remoteExists && keepBackup ? { backupPath: backup, deployedAt: new Date().toISOString() } : null);
    await recordRemoteRoot(client, plan, verifiedHashes(plan, push.uploaded));

    return { ...push, staging, backupPath: plan.remoteExists && keepBackup ? backup : null };
}

/** Puts the backup kept by the last `deploy --keep-backup` back in place. */
export async function rollback(client, remotePath, output) {
    const live = toRemotePath(remotePath);
    const recorded = client.state.getDeploy(live);
    if (!recorded?.backupPath) {
        throw createCommandError(`No backup is recorded for "${live}". Only "dw files deploy --keep-backup" keeps one.`, 404);
    }
    if (!(await client.exists(recorded.backupPath)).exists) {
        client.state.setDeploy(live, null);
        client.state.save();
        throw createCommandError(`The backup "${recorded.backupPath}" no longer exists.`, 404);
    }

    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const replaced = joinRemote(parentOf(live), `${path.posix.basename(live)}.dwrolledback-${stamp}`);
    const liveExists = (await client.exists(live)).exists;

    output.log(`Restoring ${recorded.backupPath} to ${live}`);
    if (liveExists) await client.moveEntry(live, replaced);
    try {
        await client.moveEntry(recorded.backupPath, live);
    } catch (err) {
        if (liveExists) await client.moveEntry(replaced, live).catch(() => { });
        throw createCommandError(`Could not restore "${recorded.backupPath}"; "${live}" was left as it was.`, err.status ?? 1, err.details ?? err.message);
    }
    if (liveExists) await client.deleteEntry(replaced).catch(() => { });

    client.state.setDeploy(live, null);
    // Restoring a version is an explicit choice: it becomes the new baseline.
    await recordRemoteRoot(client, { remotePath: live }, new Map(), { acceptAll: true });
    return { restored: recorded.backupPath, deployedAt: recorded.deployedAt };
}

/**
 * Lists a local directory (or a single file) as `/`-separated paths relative to it.
 * Keys are lower-cased to match the server's case-insensitive paths.
 */
export async function walkLocal(root, recursive = true) {
    const files = new Map();
    const directories = new Map();
    const stat = await fs.promises.stat(root);
    if (stat.isFile()) {
        const name = path.basename(root);
        files.set(name.toLowerCase(), { path: name, absolute: root, size: stat.size });
        return { files, directories };
    }

    async function walk(dir, prefix) {
        for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!recursive) continue;
                directories.set(relative.toLowerCase(), { path: relative, absolute });
                await walk(absolute, relative);
            } else if (entry.isFile()) {
                files.set(relative.toLowerCase(), { path: relative, absolute, size: (await fs.promises.stat(absolute)).size });
            }
        }
    }
    await walk(root, '');
    return { files, directories };
}
