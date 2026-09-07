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
 * target must resolve inside the destination directory, or extraction fails.
 *
 * @param {string} filePath - The path to the zip file to extract.
 * @param {string} destinationPath - The directory where files will be extracted.
 * @param {Object} [options] - Optional settings.
 * @param {(processedEntries: number, totalEntries: number, percent: string) => void} [options.onEntry] - Callback invoked on each entry extracted.
 *   Receives the number of processed files, total entry count, and percent complete as arguments.
 * @returns {Promise<void>} A promise that resolves when extraction is complete.
 */
export function extractWithProgress(filePath, destinationPath, options) {
    let processedEntries = 0;

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

                    await extractEntry(zipFile, entry, destinationPath);
                    zipFile.readEntry();
                } catch (e) {
                    fail(e);
                }
            });

            zipFile.readEntry();
        });
    });
}

async function extractEntry(zipFile, entry, destinationPath) {
    const root = path.resolve(destinationPath);
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
        return;
    }

    await pipeline(readStream, createWriteStream(dest, { mode: procMode }));
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

    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Out of bound path "${entryPath}" found while extracting archive`);
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
