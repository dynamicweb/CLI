import { Response } from 'node-fetch';
import fs from 'fs';

/**
 * Extracts the file name from the HTTP response.
 * @param {Response} res - The HTTP response object.
 * @returns {string} The extracted file name.
 */
export function getFileNameFromResponse(res, dirPath) {
    const header = res.headers.get('content-disposition');
    const extended = header?.match(/filename\*\s*=\s*(?:[\w-]+'[^']*')?([^;]+)/i);
    const plain = header?.match(/filename\s*=\s*("[^"]*"|[^;]+)/i);

    if (!extended && !plain) {
        const msg = `No files found in directory '${dirPath}', if you want to download all folders recursively include the -r flag`;
        throw new Error(msg);
    }

    const name = extended
        ? decodeURIComponent(extended[1].trim())
        : plain[1].trim().replace(/^"(.*)"$/, '$1').replaceAll('+', ' ');

    // The name comes from the server and is joined onto a local path: keep only the
    // last segment so it can never point outside the output directory.
    return name.split(/[\\/]/).pop();
}

/**
 * Attempts to extract the file name from an HTTP response.
 * If extraction fails, logs the error message to the console.
 *
 * @param {Object} res - The HTTP response object to extract the file name from.
 * @param {string} dirPath - The directory path to use for file name resolution.
 * @param {boolean} verbose - Whether to log missing download information.
 * @returns {string|null} The extracted file name, or null if extraction fails.
 */
export function tryGetFileNameFromResponse(res, dirPath, verbose = false) {
    try {
        return getFileNameFromResponse(res, dirPath);
    } catch (err) {
        if (verbose) {
            console.error(err.message);
        }
        return null;
    }
}

/**
 * Downloads a file with progress reporting.
 * @param {Response} res - The response from which to read the stream data.
 * @param {string} filePath - The path to write the file to.
 * @param {Object} options - Options for the download.
 * @param {(receivedBytes: number, elapsedMillis: number, isFirstChunk: boolean) => void} options.onData - Callback invoked with each data chunk.
 * @returns {Promise<void>} Resolves when the download is complete.
 */
export function downloadWithProgress(res, filePath, options) {
    // append: continue a partial file, for resumed (HTTP 206) downloads.
    const fileStream = fs.createWriteStream(filePath, { flags: options?.append ? 'a' : 'w' });
    return new Promise((resolve, reject) => {
        let receivedBytes = 0;
        let startTime = Date.now();

        res.body.pipe(fileStream);
        res.body.on("error", reject);
        // Without this, a write failure (missing directory, no permission, disk full)
        // is an unhandled 'error' event that kills the process mid-command.
        fileStream.on("error", (err) => {
            res.body.destroy();
            reject(err);
        });
        fileStream.on("finish", resolve);

        res.body.on("data", chunk => {
            const isFirstChunk = receivedBytes === 0;
            const elapsed = Date.now() - startTime;

            receivedBytes += chunk.length;

            if (options?.onData) {
                options.onData(receivedBytes, elapsed, isFirstChunk);
            }
        });
    });
}
