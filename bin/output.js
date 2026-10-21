/**
 * Extracts the human-readable reason from an API error body: either the Management
 * API's `message`, or ASP.NET validation errors (`{ "Name": ["The value is required."] }`).
 *
 * @param {*} details - The error details, usually the parsed response body.
 * @returns {string|null} A one-line reason, or null when there is none.
 */
export function describeDetails(details) {
    if (!details || typeof details !== 'object') {
        return null;
    }
    if (typeof details.message === 'string' && details.message.trim()) {
        return details.message.trim();
    }
    const validation = Object.entries(details)
        .filter(([, value]) => Array.isArray(value) && value.every(v => typeof v === 'string'))
        .map(([key, value]) => key ? `${key}: ${value.join(' ')}` : value.join(' '));
    return validation.length ? validation.join('; ') : null;
}

/**
 * Creates the output envelope every command reports through.
 *
 * In JSON mode (`--output json`) human-readable logging is suppressed and a single
 * envelope is printed to stdout by `finish()`. Otherwise logs go to stdout as they
 * happen and, if the command failed, `finish()` prints the errors to stderr, so a
 * failure is never silent in either mode.
 *
 * @param {Object} options
 * @param {string} options.command - The CLI command name, e.g. `files`.
 * @param {string} options.operation - The operation within the command, e.g. `import`.
 * @param {Object} options.argv - The parsed yargs arguments.
 * @param {Object} [options.meta] - Initial command-specific metadata.
 */
export function createOutput({ command, operation, argv = {}, meta = {} }) {
    const response = {
        ok: true,
        command,
        operation,
        status: 0,
        data: [],
        errors: [],
        meta: { ...meta }
    };
    let lastError = null;

    return {
        json: argv.output === 'json',
        verbose: Boolean(argv.verbose),
        response,
        log(...args) {
            if (!this.json) {
                console.log(...args);
            }
        },
        verboseLog(...args) {
            if (this.verbose && !this.json) {
                console.info(...args);
            }
        },
        addData(entry) {
            response.data.push(entry);
        },
        mergeMeta(metaOrFn) {
            const meta = typeof metaOrFn === 'function' ? metaOrFn(response.meta) : metaOrFn;
            response.meta = {
                ...response.meta,
                ...meta
            };
        },
        setStatus(status) {
            response.status = status;
        },
        fail(err) {
            lastError = err;
            response.ok = false;
            response.status = err?.status || 1;
            response.errors.push({
                message: err?.message || `Unknown ${command} command error.`,
                details: err?.details ?? null
            });
        },
        finish() {
            if (this.json) {
                console.log(JSON.stringify(response, null, 2));
                return;
            }

            for (const error of response.errors) {
                console.error(`Error: ${error.message}`);
                if (this.verbose && error.details) {
                    console.error(typeof error.details === 'string' ? error.details : JSON.stringify(error.details, null, 2));
                } else {
                    const reason = describeDetails(error.details);
                    if (reason) console.error(`  ${reason}`);
                }
            }
            if (this.verbose && lastError?.stack && !lastError.details) {
                console.error(lastError.stack);
            }
        }
    };
}
