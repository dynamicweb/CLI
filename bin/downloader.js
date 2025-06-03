import { Response } from 'node-fetch';
import fs from 'fs';

/**
 * Extracts the file name from the HTTP response.
 * @param {Response} res - The HTTP response object.
 * @returns {string} The extracted file name.
 */
export function getFileNameFromResponse(res) {
    const header = res.headers.get('content-disposition');
    const parts = header?.split(';');
    
    if (!parts) {
        throw new Error(`No files found in directory '${dirPath}', if you want to download all folders recursively include the -r flag`);
    }

    return parts[1].split('=')[1].replace('+', ' ');
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
    const fileStream = fs.createWriteStream(filePath);
    return new Promise((resolve, reject) => {
        let receivedBytes = 0;
        let startTime = Date.now();

        res.body.pipe(fileStream);
        res.body.on("error", reject);
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