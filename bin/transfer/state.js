import { getConfig, updateConfig } from '../commands/config.js';

/**
 * What the CLI last saw on a solution, kept in ~/.dwc under `transferState`, keyed by
 * `protocol://host` so it also works for environmentless `--host` runs:
 *
 *   transferState["https://host"] = {
 *     files:   { "<remote path, lower case>": { path, eTag, sha256, size, recordedAt } },
 *     hashes:  { "<remote path, lower case>": { eTag, sha256 } },
 *     roots:   { "<remote dir, lower case>":  { path, syncedAt } },
 *     deploys: { "<remote dir, lower case>":  { path, backupPath, deployedAt } }
 *   }
 *
 * `files` is the baseline for --fail-on-remote-change: the version of each file as the
 * CLI last left it. Only versions the CLI wrote or verified against local content are
 * recorded there -- anything else would let a change made on the server become the
 * baseline without anyone reviewing it. `hashes` is a plain cache of server checksums,
 * valid only while the file keeps that eTag, so the diff need not re-hash it.
 * Remote paths are compared case-insensitively, as the server does.
 */
const STATE_KEY = 'transferState';

export function createTransferState(env) {
    const hostKey = `${env.protocol}://${env.host}`.toLowerCase();

    function host() {
        const config = getConfig();
        config[STATE_KEY] = config[STATE_KEY] || {};
        const state = config[STATE_KEY][hostKey] = config[STATE_KEY][hostKey] || {};
        state.files = state.files || {};
        state.hashes = state.hashes || {};
        state.roots = state.roots || {};
        state.deploys = state.deploys || {};
        return state;
    }

    return {
        getFile(remotePath) {
            return getConfig()[STATE_KEY]?.[hostKey]?.files?.[key(remotePath)] ?? null;
        },
        recordFile(remotePath, { eTag, sha256, size }) {
            if (!eTag) return;
            host().files[key(remotePath)] = { path: remotePath, eTag, sha256: sha256 ?? null, size: size ?? null, recordedAt: new Date().toISOString() };
        },
        /** Recorded baseline paths (lower case) at or under `remotePath`. */
        filesUnder(remotePath) {
            const files = getConfig()[STATE_KEY]?.[hostKey]?.files ?? {};
            const prefix = key(remotePath);
            return Object.keys(files).filter(name => !prefix || name === prefix || name.startsWith(`${prefix}/`));
        },
        /** Forgets a file or a whole tree, e.g. after deleting or moving it. */
        forget(remotePath) {
            const host = getConfig()[STATE_KEY]?.[hostKey];
            if (!host) return;
            const prefix = key(remotePath);
            for (const table of [host.files, host.hashes]) {
                for (const name of Object.keys(table ?? {})) {
                    if (!prefix || name === prefix || name.startsWith(`${prefix}/`)) delete table[name];
                }
            }
        },
        /** A server checksum of one version of a file. Never part of the baseline. */
        cacheHash(remotePath, { eTag, sha256 }) {
            if (!eTag || !sha256) return;
            host().hashes[key(remotePath)] = { eTag, sha256 };
        },
        /** The SHA-256 of the file at `eTag`, from the baseline or the cache, if known. */
        knownHash(remotePath, eTag) {
            const state = getConfig()[STATE_KEY]?.[hostKey];
            for (const entry of [state?.files?.[key(remotePath)], state?.hashes?.[key(remotePath)]]) {
                if (entry?.sha256 && entry.eTag === eTag) return entry.sha256;
            }
            return null;
        },
        getRoot(remotePath) {
            return getConfig()[STATE_KEY]?.[hostKey]?.roots?.[key(remotePath)] ?? null;
        },
        /** Whether this directory, or one containing it, has been synced by the CLI. */
        isTracked(remotePath) {
            const roots = getConfig()[STATE_KEY]?.[hostKey]?.roots ?? {};
            const target = key(remotePath);
            return Object.keys(roots).some(root => root === target || root === '' || target.startsWith(`${root}/`));
        },
        markRootSynced(remotePath) {
            host().roots[key(remotePath)] = { path: remotePath, syncedAt: new Date().toISOString() };
        },
        unmarkRoot(remotePath) {
            delete getConfig()[STATE_KEY]?.[hostKey]?.roots?.[key(remotePath)];
        },
        getDeploy(remotePath) {
            return getConfig()[STATE_KEY]?.[hostKey]?.deploys?.[key(remotePath)] ?? null;
        },
        setDeploy(remotePath, deploy) {
            if (deploy) {
                host().deploys[key(remotePath)] = { path: remotePath, ...deploy };
            } else {
                delete getConfig()[STATE_KEY]?.[hostKey]?.deploys?.[key(remotePath)];
            }
        },
        save() {
            if (getConfig()[STATE_KEY]?.[hostKey]) updateConfig();
        }
    };
}

function key(remotePath) {
    return String(remotePath ?? '').toLowerCase();
}
