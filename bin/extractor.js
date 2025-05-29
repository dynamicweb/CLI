import extract from 'extract-zip';

/**
 * Extracts files from a zip archive with progress reporting.
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

    return extract(filePath, {
        dir: destinationPath,
        onEntry: (_, zipFile) => {
            processedEntries++;

            const percent = Math.floor((processedEntries / zipFile.entryCount) * 100).toFixed(0);

            if (options?.onEntry) {
                options.onEntry(processedEntries, zipFile.entryCount, percent);
            }
        }
    }, function (err) {});
}
