import { setupEnv, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { interactiveConfirm, formatBytes } from '../utils.js';
import { createOutput } from '../output.js';
import { requireFileTransfer, resolveTransfer } from '../transfer/index.js';
import { toRemotePath } from '../transfer/filetransfer.js';
import { applyPush, assertNoConflicts, blockingConflicts, buildPlan, deploy, recordRemoteRoot, rollback, verifiedHashes } from '../transfer/sync.js';

/**
 * `dw files <subcommand>`: operations that only exist with the File Transfer API.
 * Each fails with a clear error on solutions without it, or with --transfer legacy.
 */
export function filesSubcommands() {
    return [
        {
            command: 'diff <localPath> <remotePath>',
            describe: 'Compares a local directory with a remote one without changing anything',
            builder: (yargs) => outputOption(yargs
                .positional('localPath', { describe: 'Local directory' })
                .positional('remotePath', { describe: 'Remote directory it corresponds to' })
                .option('showUnchanged', { type: 'boolean', describe: 'Also list unchanged files' })),
            handler: run('diff', async (argv, output, client) => {
                const plan = await buildPlan(client, { localRoot: argv.localPath, remoteRoot: argv.remotePath });
                output.addData({ type: 'diff', ...planData(plan) });
                printPlan(plan, output, { showUnchanged: argv.showUnchanged, deleting: false });
            })
        },
        {
            command: 'sync <localPath> <remotePath>',
            describe: 'Makes a remote directory match a local one, transferring only what changed',
            builder: (yargs) => outputOption(pushOptions(yargs)
                .option('delete', { type: 'boolean', describe: 'Also delete remote files and directories that do not exist locally' })),
            handler: run('sync', async (argv, output, client) => {
                const plan = await buildPlan(client, { localRoot: argv.localPath, remoteRoot: argv.remotePath });
                if (argv.failOnRemoteChange) {
                    assertNoConflicts(blockingConflicts(plan, { deleteRemoteOnly: argv.delete }));
                }
                const removals = argv.delete ? plan.summary.remoteOnly + plan.summary.directories.remoteOnly : 0;

                if (argv.dryRun) {
                    output.addData({ type: 'sync', dryRun: true, delete: Boolean(argv.delete), ...planData(plan) });
                    printPlan(plan, output, { deleting: argv.delete });
                    return;
                }

                const apply = async () => {
                    const result = await applyPush(client, plan, { deleteRemoteOnly: argv.delete, guard: argv.failOnRemoteChange }, output);
                    await recordRemoteRoot(client, plan, verifiedHashes(plan, result.uploaded));
                    output.mergeMeta({ chunks: result.chunks });
                    output.addData({
                        type: 'sync',
                        dryRun: false,
                        delete: Boolean(argv.delete),
                        localPath: plan.localPath,
                        remotePath: plan.remotePath,
                        summary: plan.summary,
                        uploaded: result.uploaded,
                        deleted: result.deleted
                    });
                    output.log(`Synced ${plan.localPath} to ${plan.remotePath || '/'}: ${result.uploaded.length} uploaded, ${result.deleted.length} deleted, ${plan.summary.unchanged} unchanged`);
                };

                if (removals > 0 && !output.json) {
                    await confirmOrCancel(`Delete ${removals} remote item(s) that do not exist locally?`, apply, output);
                } else {
                    await apply();
                }
            })
        },
        {
            command: 'deploy <localPath> <remotePath>',
            describe: 'Replaces a remote directory with a local one in a single switch-over',
            builder: (yargs) => outputOption(pushOptions(yargs)
                .option('keepBackup', { type: 'boolean', describe: 'Keep the replaced version so "dw files rollback" can restore it' })),
            handler: run('deploy', async (argv, output, client) => {
                const plan = await buildPlan(client, { localRoot: argv.localPath, remoteRoot: argv.remotePath });
                if (argv.failOnRemoteChange) {
                    assertNoConflicts(blockingConflicts(plan, { deleteRemoteOnly: true }));
                }

                if (argv.dryRun) {
                    output.addData({ type: 'deploy', dryRun: true, ...planData(plan) });
                    printPlan(plan, output, { deleting: true });
                    return;
                }

                const apply = async () => {
                    const result = await deploy(client, plan, { keepBackup: argv.keepBackup }, output);
                    output.mergeMeta({ chunks: result.chunks });
                    output.addData({
                        type: 'deploy',
                        dryRun: false,
                        localPath: plan.localPath,
                        remotePath: plan.remotePath,
                        summary: plan.summary,
                        uploaded: result.uploaded,
                        deleted: result.deleted,
                        backupPath: result.backupPath
                    });
                    output.log(`Deployed ${plan.localPath} to ${plan.remotePath}: ${result.uploaded.length} uploaded, ${result.deleted.length} deleted${result.backupPath ? `, previous version kept at ${result.backupPath}` : ''}`);
                };

                if (!output.json) {
                    const { new: added, changed, remoteOnly } = plan.summary;
                    await confirmOrCancel(`Replace "${plan.remotePath}" with ${plan.localPath} (${added} new, ${changed} changed, ${remoteOnly} removed)?`, apply, output);
                } else {
                    await apply();
                }
            })
        },
        {
            command: 'rollback <remotePath>',
            describe: 'Restores the version replaced by the last "dw files deploy --keep-backup"',
            builder: (yargs) => outputOption(yargs.positional('remotePath', { describe: 'The deployed remote directory' })),
            handler: run('rollback', async (argv, output, client) => {
                const apply = async () => {
                    const result = await rollback(client, argv.remotePath, output);
                    output.addData({ type: 'rollback', remotePath: toRemotePath(argv.remotePath), ...result });
                    output.log(`Restored ${result.restored} to ${toRemotePath(argv.remotePath)}`);
                };
                if (!output.json) {
                    await confirmOrCancel(`Replace "${toRemotePath(argv.remotePath)}" with the backup from the last deploy?`, apply, output);
                } else {
                    await apply();
                }
            })
        },
        {
            command: 'stat <path>',
            describe: 'Shows size, modification time and version (eTag) of a remote file or directory',
            builder: (yargs) => outputOption(yargs
                .positional('path', { describe: 'Remote path' })
                .option('checksum', { type: 'boolean', describe: 'Also compute the file\'s SHA-256 on the server' })),
            handler: run('stat', async (argv, output, client) => {
                let entry;
                try {
                    entry = await client.metadata(argv.path);
                } catch (err) {
                    throw createCommandError(`Unable to read "${argv.path}".`, err.status ?? 1, err.details ?? err.message);
                }
                const data = { type: 'stat', path: entry.path, name: entry.name, isDirectory: entry.isDirectory, size: entry.size, modifiedUtc: entry.modifiedUtc, eTag: entry.eTag };
                if (argv.checksum && !entry.isDirectory) {
                    data.sha256 = (await client.checksum(argv.path)).value;
                    client.state.save();
                }
                output.addData(data);
                output.log(`${data.path}\n  type:     ${data.isDirectory ? 'directory' : 'file'}${data.isDirectory ? '' : `\n  size:     ${formatBytes(data.size)} (${data.size} bytes)`}\n  modified: ${data.modifiedUtc}${data.eTag ? `\n  eTag:     ${data.eTag}` : ''}${data.sha256 ? `\n  sha256:   ${data.sha256}` : ''}`);
            })
        },
        {
            command: 'usage [path]',
            describe: 'Shows the total size and number of files and directories under a remote directory',
            builder: (yargs) => outputOption(yargs.positional('path', { describe: 'Remote directory (default: the whole file archive)' })),
            handler: run('usage', async (argv, output, client) => {
                let usage;
                try {
                    usage = await client.usage(argv.path ?? '');
                } catch (err) {
                    throw createCommandError(`Unable to read "${argv.path ?? '/'}".`, err.status ?? 1, err.details ?? err.message);
                }
                output.addData({ type: 'usage', path: usage.path, totalBytes: usage.totalBytes, fileCount: usage.fileCount, directoryCount: usage.directoryCount });
                output.log(`${usage.path || '/'}: ${formatBytes(usage.totalBytes)} in ${usage.fileCount} file(s) and ${usage.directoryCount} directories`);
            })
        }
    ];
}

/** Wraps a subcommand body with the shared envelope, setup and File Transfer check. */
function run(operation, body) {
    return async (argv) => {
        const output = createOutput({ command: 'files', operation, argv });
        try {
            const env = await setupEnv(argv, output);
            const user = await setupUser(argv, env);
            const transfer = await resolveTransfer(argv, env, user, output);
            await body(argv, output, requireFileTransfer(transfer, `"dw files ${operation}"`));
        } catch (err) {
            output.fail(err);
            process.exitCode = 1;
        } finally {
            output.finish();
        }
    };
}

function pushOptions(yargs) {
    return yargs
        .positional('localPath', { describe: 'Local directory' })
        .positional('remotePath', { describe: 'Remote directory to update; its contents will match the local directory' })
        .option('dryRun', { type: 'boolean', describe: 'Show what would change without changing anything' })
        .option('failOnRemoteChange', { type: 'boolean', describe: 'Stop without changing anything if files changed on the server since the last sync' });
}

function outputOption(yargs) {
    return yargs.option('output', {
        choices: ['json'],
        describe: 'Outputs a single JSON response for automation-friendly parsing'
    });
}

async function confirmOrCancel(question, apply, output) {
    let applied = false;
    await interactiveConfirm(question, async () => {
        applied = true;
        await apply();
    });
    if (!applied) {
        output.log('Cancelled, nothing was changed.');
    }
}

function planData(plan) {
    return {
        localPath: plan.localPath,
        remotePath: plan.remotePath,
        remoteExists: plan.remoteExists,
        syncedBefore: plan.syncedBefore,
        summary: plan.summary,
        items: plan.items
    };
}

const SYMBOLS = { 'new': '+', 'changed': '~', 'remote-only': '-', 'unchanged': '=' };

function printPlan(plan, output, { showUnchanged = false, deleting = true } = {}) {
    for (const item of plan.items) {
        if (item.action === 'unchanged' && !showUnchanged) continue;
        const suffix = [
            item.type === 'directory' ? 'directory' : null,
            item.action === 'remote-only' ? (deleting ? 'remote only, will be deleted' : 'remote only') : null,
            item.conflict ? `CONFLICT: ${item.conflict}` : null
        ].filter(Boolean).join(', ');
        output.log(`${item.conflict ? '!' : SYMBOLS[item.action]} ${item.path}${suffix ? `  (${suffix})` : ''}`);
    }
    const s = plan.summary;
    output.log(`${s.new} new, ${s.changed} changed, ${s.unchanged} unchanged, ${s.remoteOnly} remote only${s.conflicts ? `, ${s.conflicts} changed on the server since the last sync` : ''}${s.directories.new || s.directories.remoteOnly ? ` (directories: ${s.directories.new} new, ${s.directories.remoteOnly} remote only)` : ''}`);
}
