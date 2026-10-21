import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import yauzl from 'yauzl';

const pipeline = promisify(stream.pipeline);

// Stat mode constants, used to classify an entry from its external file attributes.
const IFMT = 61440;
const IFDIR = 16384;
const IFLNK = 40960;

/**
 * Extracts files from a zip archive with progress reporting.
 *
 * Replaces the unmaintained extract-zip (GHSA-jmr9-qjv8-65gv): that package created
 * symlinks from archive entries without validating their targets, so an archive
 * containing a symlink to an absolute or ../ path could write outside the destination
 * on the next entry that resolved through it. Here every entry path AND every symlink
 * target must resolve inside the destination directory, or extraction fails -- both
 * lexically and on disk, so a symlink or junction already present in the destination
 * cannot redirect a write either.
 *
 * @param {string} filePath - The path to the zip file to extract.
 * @param {string} destinationPath - The directory where files will be extracted.
 * @param {Object} [options] - Optional settings.
 * @param {(processedEntries: number, totalEntries: number, percent: string) => void} [options.onEntry] - Callback invoked on each entry extracted.
 *   Receives the number of processed files, total entry count, and percent complete as arguments.
 * @returns {Promise<void>} A promise that resolves when extraction is complete.
 */
export async function extractWithProgress(filePath, destinationPath, options) {
    let processedEntries = 0;
    const root = path.resolve(destinationPath);
    await fs.mkdir(root, { recursive: true });
    // The destination itself may legitimately be a link; containment is checked
    // against where it really lives.
    const realRoot = await fs.realpath(root);

    return new Promise((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true }, (err, zipFile) => {
            if (err) return reject(err);

            let settled = false;
            const fail = (e) => {
                if (settled) return;
                settled = true;
                zipFile.close();
                reject(e);
            };

            zipFile.on('error', fail);
            zipFile.on('close', () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            });

            zipFile.on('entry', async (entry) => {
                if (settled) return;

                // Resource forks from archives built on macOS; never extracted.
                if (entry.fileName.startsWith('__MACOSX/')) {
                    zipFile.readEntry();
                    return;
                }

                try {
                    processedEntries++;

                    const percent = Math.floor((processedEntries / zipFile.entryCount) * 100).toFixed(0);

                    if (options?.onEntry) {
                        options.onEntry(processedEntries, zipFile.entryCount, percent);
                    }

                    await extractEntry(zipFile, entry, root, realRoot);
                    zipFile.readEntry();
                } catch (e) {
                    fail(e);
                }
            });

            zipFile.readEntry();
        });
    });
}

async function extractEntry(zipFile, entry, root, realRoot) {
    const dest = resolveWithinRoot(root, entry.fileName);

    // Convert the external file attributes into an fs stat mode.
    const mode = (entry.externalFileAttributes >> 16) & 0xFFFF;
    const isSymlink = (mode & IFMT) === IFLNK;
    let isDir = (mode & IFMT) === IFDIR;

    // Archives do not always set the directory bit; trailing slash is the failsafe.
    if (!isDir && entry.fileName.endsWith('/')) {
        isDir = true;
    }

    // Directories written by some Windows zip tools are only identifiable this way.
    // https://github.com/maxogden/extract-zip/issues/13#issuecomment-154494566
    const madeBy = entry.versionMadeBy >> 8;
    if (!isDir) isDir = (madeBy === 0 && entry.externalFileAttributes === 16);

    const procMode = getExtractedMode(mode, isDir) & 0o777;

    // mkdir and createWriteStream follow links, so the lexical check above is not
    // enough when the destination already holds a link pointing elsewhere.
    await assertOnDiskWithinRoot(realRoot, dest, entry.fileName);

    if (isDir) {
        await fs.mkdir(dest, { recursive: true, mode: procMode });
        return;
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });

    const readStream = await promisify(zipFile.openReadStream.bind(zipFile))(entry);

    if (isSymlink) {
        const target = await readAll(readStream);

        // The unvalidated version of this is the advisory: a target escaping the
        // destination turns any later entry into an arbitrary file write.
        resolveWithinRoot(root, path.join(path.dirname(entry.fileName), target));

        await fs.symlink(target, dest);

        // The target is lexically inside, but may still resolve through an existing
        // link to somewhere outside; never leave such a link behind.
        const real = await realpathOrNull(dest);
        if (real && !isWithin(realRoot, real)) {
            await fs.unlink(dest);
            throw outOfBounds(entry.fileName);
        }
        return;
    }

    await pipeline(readStream, createWriteStream(dest, { mode: procMode }));
}

/**
 * Rejects a target path whose deepest existing component resolves, through any links
 * or junctions on disk, outside the destination. Components that do not exist yet are
 * created by the extraction itself and so cannot redirect anything.
 *
 * @param {string} realRoot - The real path of the destination directory.
 * @param {string} target - The lexically validated absolute path about to be written.
 * @param {string} entryPath - The path as recorded in the archive, for the error.
 */
async function assertOnDiskWithinRoot(realRoot, target, entryPath) {
    if (!(await resolvesWithinRoot(realRoot, target))) {
        throw outOfBounds(entryPath);
    }
}

/**
 * Whether writing `target` stays inside `realRoot` on disk: its deepest existing
 * component must resolve, through any links or junctions, inside the root. Shared with
 * the File Transfer downloads, which write server-supplied paths the same way.
 *
 * @param {string} realRoot - The real path (fs.realpath) of the destination directory.
 * @param {string} target - The lexically validated absolute path about to be written.
 * @returns {Promise<boolean>}
 */
export async function resolvesWithinRoot(realRoot, target) {
    let existing = target;
    while (!(await lstatOrNull(existing))) {
        const parent = path.dirname(existing);
        if (parent === existing) return true;
        existing = parent;
    }

    // A dangling link has no real path, but writing through it would create its target.
    const real = await realpathOrNull(existing);
    return Boolean(real) && isWithin(realRoot, real);
}

async function lstatOrNull(p) {
    try {
        return await fs.lstat(p);
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
        throw e;
    }
}

async function realpathOrNull(p) {
    try {
        return await fs.realpath(p);
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
        throw e;
    }
}

function isWithin(root, resolved) {
    const relative = path.relative(root, resolved);
    return !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
}

function outOfBounds(entryPath) {
    return new Error(`Out of bound path "${entryPath}" found while extracting archive`);
}

/**
 * Joins an archive-supplied path onto the destination root, rejecting anything that
 * escapes it (via .. segments, an absolute path, or a drive letter on Windows).
 *
 * @param {string} root - The resolved destination directory.
 * @param {string} entryPath - The path as recorded in the archive.
 * @returns {string} The resolved absolute path, guaranteed to sit under root.
 */
function resolveWithinRoot(root, entryPath) {
    const resolved = path.resolve(root, entryPath);
    const relative = path.relative(root, resolved);

    if (relative === '' || !isWithin(root, resolved)) {
        throw outOfBounds(entryPath);
    }

    return resolved;
}

function readAll(readStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readStream.on('data', (c) => chunks.push(c));
        readStream.on('end', () => resolve(Buffer.concat(chunks).toString()));
        readStream.on('error', reject);
    });
}

function getExtractedMode(entryMode, isDir) {
    let mode = entryMode;

    if (mode === 0) {
        return isDir ? 0o755 : 0o644;
    }

    return mode;
}
