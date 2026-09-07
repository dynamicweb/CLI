import { confirm } from '@inquirer/prompts';
import logUpdate from 'log-update';

const WRITE_THROTTLE_MS = 500;

// Query-string keys whose values must never be printed. Matched on the
// normalised name, so apiKey, api-key and API_KEY are all covered.
const SENSITIVE_PARAMS = ['apikey', 'key', 'token', 'accesstoken', 'password', 'secret', 'signature', 'sig'];

/**
 * Normalises an option name for comparison: lowercased, with separators removed.
 *
 * yargs puts every spelling of a camelCase option into argv -- `apiKey` and the
 * generated `api-key` alias both appear -- so comparing literal names lets one
 * spelling through. Normalising catches all of them, including aliases added
 * later.
 *
 * @param {string} name - The option name as it appears in argv.
 * @returns {string} The normalised name.
 */
export function normalizeOptionName(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Builds a predicate that tells parameters destined for the remote endpoint apart
 * from the CLI's own switches.
 *
 * @param {string[]} reserved - The CLI's own option names, in any spelling.
 * @returns {(name: string) => boolean} True when the name is a remote parameter.
 */
export function isRemoteParam(reserved) {
    const names = new Set(reserved.map(normalizeOptionName));
    return (name) => !names.has(normalizeOptionName(name));
}

/**
 * Replaces the values of credential-bearing query parameters with `***`, so a URL
 * can be shown in an error message without putting a secret in the terminal, in CI
 * logs or in a saved transcript.
 *
 * @param {string} url - The URL to redact.
 * @returns {string} The URL with sensitive parameter values masked.
 */
export function redactUrl(url) {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        for (const name of [...parsed.searchParams.keys()]) {
            if (SENSITIVE_PARAMS.includes(normalizeOptionName(name))) {
                parsed.searchParams.set(name, '***');
            }
        }
        return parsed.toString();
    } catch {
        // Not a parsable URL; fall back to masking anything that reads like a secret
        // rather than returning the input unchanged.
        return String(url).replace(/([?&][^=&]*(?:key|token|secret|password|sig)[^=&]*=)[^&]*/gi, '$1***');
    }
}

export async function interactiveConfirm(question, func) {
    const result = await confirm({ message: question, default: true });
    if (!result) return;
    await func();
}

/**
 * Creates a throttled status updater that periodically logs status messages and elapsed time.
 *
 * The updater allows you to update the displayed status message at any time, but throttles the actual log updates
 * to the specified interval. When called with no message, the updater stops and finalizes the log output.
 *
 * @param {number} [intervalMs=WRITE_THROTTLE_MS] - The interval in milliseconds at which to update the log output.
 * @returns {{
 *   update: (message?: string) => void,
 *   stop: () => void
 * }} An object with `update` and `stop` methods:
 *   - `update(message)`: Updates the status message and starts the updater if not already running. If called with no message, stops the updater.
 *   - `stop()`: Stops the updater and finalizes the log output.
 *
 * @example
 * const updater = createThrottledStatusUpdater(500);
 * updater.update('Processing...');
 * // ... later
 * updater.update('Still working...');
 * // ... when done
 * updater.update(); // or updater.stop();
 */
export function createThrottledStatusUpdater(intervalMs = WRITE_THROTTLE_MS) {
    let latestMessage;
    let timer = null;
    let stopped = false;
    let startTime;

    function write() {
        const elapsed = `Elapsed:\t${formatElapsed(Date.now() - startTime)}`;
        const lines = latestMessage ? [latestMessage, elapsed] : [elapsed];
        logUpdate(lines.join('\n'));
    }

    function start() {
        if (timer) return;

        startTime = Date.now();

        timer = setInterval(() => {
            if (stopped) return;
            write();
        }, intervalMs);
    }

    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        write();
        logUpdate.done();
    }

    // The updater function you call from anywhere
    function update(message) {
        if (!message) {
            stop();
            return;
        }
        latestMessage = message;
        start();
    }

    return {
        update,
        stop
    };
}

/**
 * Converts a number of bytes into a human-readable string with appropriate units.
 *
 * @param {number} bytes - The number of bytes to format.
 * @returns {string} The formatted string representing the size in appropriate units (Bytes, KB, MB, GB, TB, PB).
 */
export function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

/**
 * Formats a duration given in milliseconds into a human-readable string.
 *
 * The output is in the format:
 * - "Xh Ym Zs" if the duration is at least 1 hour,
 * - "Ym Zs" if the duration is at least 1 minute but less than 1 hour,
 * - "Zs" if the duration is less than 1 minute.
 *
 * @param {number} ms - The duration in milliseconds.
 * @returns {string} The formatted elapsed time string.
 */
export function formatElapsed(ms) {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    if (hr > 0) return `${hr}h ${min % 60}m ${sec % 60}s`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
}
