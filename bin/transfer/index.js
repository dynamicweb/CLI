import fetch from 'node-fetch';
import { getAgent, createCommandError } from '../commands/env.js';
import { createFileTransferClient } from './filetransfer.js';
import { createThrottle, parseJsonSafe, resolveConcurrency } from './throttle.js';

export const TRANSFER_MODES = ['auto', 'filetransfer', 'legacy'];
export const TRANSFER_ENV_VAR = 'DW_TRANSFER';

/**
 * Decides which implementation moves files for this command: the File Transfer API
 * (`filetransfer`) or the original Management API endpoints (`legacy`).
 *
 * The mode comes from `--transfer`, then the `DW_TRANSFER` environment variable, then
 * the environment's `transfer` setting in ~/.dwc, and defaults to `auto`, which probes
 * the solution once. An explicit `filetransfer` never falls back: a test or pipeline
 * asking for it must not silently run the other implementation.
 *
 * @param {Object} argv - Parsed arguments.
 * @param {Object} env - The resolved environment ({ protocol, host, transfer? }).
 * @param {Object} user - The resolved credentials ({ apiKey }).
 * @param {Object} output - The command's output envelope.
 * @param {Object} [options]
 * @param {boolean} [options.legacyOnly] - The operation only exists in the legacy
 *   implementation (e.g. `--raw` zip exports).
 * @returns {Promise<{ name: 'filetransfer'|'legacy', source: string, client: Object|null }>}
 */
export async function resolveTransfer(argv, env, user, output, { legacyOnly = false, probe = probeFileTransfer, throttleOptions = {} } = {}) {
    const { mode, source } = resolveTransferMode(argv, env);
    let name;
    let throttle = null;

    if (mode === 'legacy') {
        name = 'legacy';
    } else if (legacyOnly) {
        if (mode === 'filetransfer') {
            throw createCommandError('--raw keeps the server-side zip archive, which only the legacy transfer produces. Use --transfer legacy or auto.', 400);
        }
        name = 'legacy';
    } else {
        throttle = createThrottle({
            concurrency: resolveConcurrency(argv),
            ...throttleOptions,
            onThrottle: ({ waitMs, requestsPerSecond }) => {
                const pause = waitMs >= 1000 ? `pausing ${Math.round(waitMs / 1000)}s, then ` : '';
                output.log(`The server is rate-limiting requests; ${pause}continuing one request at a time (at most ${requestsPerSecond}/s).`);
            }
        });
        const supported = await probe(env, user, throttle);
        if (!supported && mode === 'filetransfer') {
            throw createCommandError(`This solution does not provide the File Transfer API (/Admin/Api/FileTransfer). Use --transfer legacy or auto.`, 404);
        }
        name = supported ? 'filetransfer' : 'legacy';
    }

    output.mergeMeta({ transfer: name, transferSource: source });
    output.verboseLog(`Using ${name} file transfer (${source}${mode === 'auto' ? ', detected' : ''})`);

    return {
        name,
        mode,
        source,
        client: name === 'filetransfer' ? createFileTransferClient(env, user, { throttle }) : null
    };
}

/**
 * Fails when an operation that only exists with the File Transfer API resolved to the
 * legacy transfer, saying why.
 */
export function requireFileTransfer(transfer, what) {
    if (transfer.client) return transfer.client;
    const reason = transfer.mode === 'legacy'
        ? `but the legacy transfer was selected (${transfer.source === 'flag' ? '--transfer' : transfer.source === 'env' ? TRANSFER_ENV_VAR : 'the environment\'s "transfer" setting'})`
        : 'which this solution does not provide';
    throw createCommandError(`${what} requires the File Transfer API, ${reason}.`, 400);
}

/**
 * @returns {{ mode: 'auto'|'filetransfer'|'legacy', source: 'flag'|'env'|'config'|'default' }}
 */
export function resolveTransferMode(argv, env = {}, environment = process.env) {
    const candidates = [
        ['flag', argv.transfer],
        ['env', environment[TRANSFER_ENV_VAR]],
        ['config', env?.transfer]
    ];

    for (const [source, value] of candidates) {
        if (value === undefined || value === null || value === '') continue;
        const mode = String(value).trim().toLowerCase();
        if (!TRANSFER_MODES.includes(mode)) {
            const origin = source === 'flag' ? '--transfer' : source === 'env' ? TRANSFER_ENV_VAR : 'the environment\'s "transfer" setting';
            throw createCommandError(`Invalid transfer mode "${value}" in ${origin}. Use one of: ${TRANSFER_MODES.join(', ')}.`, 400);
        }
        return { mode, source };
    }

    return { mode: 'auto', source: 'default' };
}

/**
 * Checks whether the solution exposes the File Transfer API with one read-only request.
 * A 404 means it does not; an authentication failure is reported, not treated as
 * "unsupported", so bad credentials never quietly switch implementations.
 */
export async function probeFileTransfer(env, user, throttle) {
    // Through the client's throttle, so a rate-limited check (HTTP 429) is retried.
    const { res, body } = await throttle.send(() => fetch(`${env.protocol}://${env.host}/Admin/Api/FileTransfer/entries/exists?path=`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${user.apiKey}` },
        agent: getAgent(env.protocol)
    }));
    return classifyProbeResponse(res.status, res.ok ? await parseJsonSafe(res) : body);
}

export function classifyProbeResponse(status, body) {
    if (status === 200 && typeof body?.exists === 'boolean') {
        return true;
    }
    if (status === 404 || status === 405) {
        return false;
    }
    // The probe reads the files root, which a user limited to some folders may not read.
    // The API's own FORBIDDEN error still proves it exists and accepted the token; the
    // operation itself then enforces the permissions on the paths it touches.
    if (status === 403 && body?.code === 'FORBIDDEN') {
        return true;
    }
    // A 403 that is not JSON did not come from Dynamicweb: something in front of the
    // solution refused the client, which may be the credentials or may be a firewall or
    // rate limit (the first request of a command cannot tell them apart).
    if (status === 403 && body === null) {
        throw createCommandError('The solution refused the request (HTTP 403) without a Dynamicweb error: the API key or token may be rejected, or a firewall or rate limit in front of the solution (such as IIS Dynamic IP Restrictions) blocked this client.', status, body);
    }
    if (status === 401 || status === 403) {
        throw createCommandError(`Authentication failed: the solution rejected the API key or token (HTTP ${status}).`, status, body);
    }
    throw createCommandError(`Unexpected response from the File Transfer API check (HTTP ${status}).`, status, body);
}

