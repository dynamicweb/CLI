import fetch from 'node-fetch';
import path from 'path';
import { setupEnv, getAgent, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { handleFiles } from './files.js';
import { createOutput } from '../output.js';
import { resolveTransfer } from '../transfer/index.js';

export function foldersCommand() {
    return {
        command: 'folders <folderPath>',
        describe: 'Manages remote directories',
        builder: (yargs) => {
            return yargs
                .positional('folderPath', {
                    describe: 'The remote directory path to operate on'
                })
                .option('create', {
                    alias: 'c',
                    type: 'boolean',
                    describe: 'Creates the directory at [folderPath]'
                })
                .option('rename', {
                    alias: 'rn',
                    type: 'string',
                    describe: 'Renames the directory at [folderPath] to the given name'
                })
                .option('move', {
                    alias: 'm',
                    type: 'string',
                    describe: 'Moves the directory at [folderPath] to the given destination path'
                })
                .option('delete', {
                    alias: 'd',
                    type: 'boolean',
                    describe: 'Deletes the directory at [folderPath]'
                })
                .option('empty', {
                    type: 'boolean',
                    describe: 'Used with --delete, empties the directory instead of deleting it'
                })
                .option('copy', {
                    type: 'string',
                    describe: 'Copies the directory at [folderPath] to the given destination path'
                })
                .option('export', {
                    alias: 'e',
                    type: 'boolean',
                    describe: 'Exports the directory at [folderPath] to [outPath]'
                })
                .option('outPath', {
                    alias: 'o',
                    type: 'string',
                    describe: 'Used with --export, local destination path (defaults to .)',
                    default: '.'
                })
                .option('raw', {
                    type: 'boolean',
                    describe: 'Used with --export, keeps zip file instead of unpacking it'
                })
                .option('output', {
                    choices: ['json'],
                    describe: 'Outputs a single JSON response for automation-friendly parsing'
                })
        },
        handler: async (argv) => {
            const output = createFoldersOutput(argv);

            try {
                await handleFolders(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    };
}

async function handleFolders(argv, output) {
    if (getFoldersOperation(argv) === 'unknown') {
        throw createCommandError('No operation specified. Use one of --create, --rename, --move, --delete, --copy or --export.', 400);
    }

    let env = await setupEnv(argv, output);
    let user = await setupUser(argv, env);
    const transfer = await resolveTransfer(argv, env, user, output, { legacyOnly: Boolean(argv.export && argv.raw) });
    const ft = transfer.client;

    if (argv.create) {
        await (ft ? ft.createDirectory(argv.folderPath, output) : createFolder(env, user, argv.folderPath, output));
    } else if (argv.rename) {
        await (ft ? ft.renameDirectory(argv.folderPath, argv.rename, output) : renameFolder(env, user, argv.folderPath, argv.rename, output));
    } else if (argv.move) {
        await (ft ? ft.moveDirectory(argv.folderPath, argv.move, output) : moveFolder(env, user, argv.folderPath, argv.move, output));
    } else if (argv.delete) {
        // handleFiles asks for confirmation outside JSON mode.
        await deleteFolderViaFiles(env, user, transfer, argv, output);
    } else if (argv.copy) {
        await copyFolderViaFiles(env, user, transfer, argv, output);
    } else if (argv.export) {
        await exportFolderViaFiles(env, user, transfer, argv, output);
    }
}

async function createFolder(env, user, folderPath, output) {
    const parentPath = path.posix.dirname(folderPath);
    const name = path.posix.basename(folderPath);

    output.log(`Creating directory: ${folderPath}`);

    // DirectorySave takes the new name on the command and the parent in its model;
    // a model without a Name creates the directory.
    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/DirectorySave`, {
        method: 'POST',
        body: JSON.stringify({
            Name: name,
            Model: {
                ParentPath: parentPath === '.' ? '/' : parentPath
            }
        }),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    if (!res.ok) {
        throw createCommandError(`Failed to create directory "${folderPath}".`, res.status, await parseJsonSafe(res));
    }

    const body = await parseJsonSafe(res);

    output.addData({ type: 'create', path: folderPath, response: body });
    output.log(`Successfully created: ${folderPath}`);
}

async function renameFolder(env, user, folderPath, newName, output) {
    const parentPath = path.posix.dirname(folderPath);
    const currentName = path.posix.basename(folderPath);

    output.log(`Renaming directory "${currentName}" to "${newName}"`);

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/DirectorySave`, {
        method: 'POST',
        // The model identifies the existing directory; the command Name is the new name.
        body: JSON.stringify({
            Name: newName,
            Model: {
                Name: currentName,
                ParentPath: parentPath === '.' ? '/' : parentPath
            }
        }),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    if (!res.ok) {
        throw createCommandError(`Failed to rename "${folderPath}" to "${newName}".`, res.status, await parseJsonSafe(res));
    }

    const body = await parseJsonSafe(res);

    output.addData({ type: 'rename', path: folderPath, newName, response: body });
    output.log(`Successfully renamed "${currentName}" to "${newName}"`);
}

async function moveFolder(env, user, sourcePath, destinationPath, output) {
    output.log(`Moving directory "${sourcePath}" to "${destinationPath}"`);

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/DirectoryMove`, {
        method: 'POST',
        body: JSON.stringify({
            SourcePath: sourcePath,
            DestinationPath: destinationPath
        }),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    if (!res.ok) {
        throw createCommandError(`Failed to move "${sourcePath}" to "${destinationPath}".`, res.status, await parseJsonSafe(res));
    }

    const body = await parseJsonSafe(res);

    output.addData({ type: 'move', sourcePath, destinationPath, response: body });
    output.log(`Successfully moved "${sourcePath}" to "${destinationPath}"`);
}

async function deleteFolderViaFiles(env, user, transfer, argv, output) {
    await handleFiles({
        ...argv,
        dirPath: argv.folderPath,
        asDirectory: true,
        asFile: false
    }, output, { env, user, transfer });
}

async function copyFolderViaFiles(env, user, transfer, argv, output) {
    await handleFiles({
        ...argv,
        dirPath: argv.folderPath,
        asDirectory: true,
        asFile: false
    }, output, { env, user, transfer });
}

async function exportFolderViaFiles(env, user, transfer, argv, output) {
    await handleFiles({
        ...argv,
        dirPath: argv.folderPath,
        outPath: argv.outPath,
        asDirectory: true,
        asFile: false
    }, output, { env, user, transfer });
}

async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

function createFoldersOutput(argv) {
    return createOutput({ command: 'folders', operation: getFoldersOperation(argv), argv });
}

function getFoldersOperation(argv) {
    if (argv.create) return 'create';
    if (argv.rename) return 'rename';
    if (argv.move) return 'move';
    if (argv.delete) return 'delete';
    if (argv.copy) return 'copy';
    if (argv.export) return 'export';
    return 'unknown';
}
