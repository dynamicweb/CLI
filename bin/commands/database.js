import fetch from 'node-fetch';
import fs from 'fs';
import _path from 'path';
import { setupEnv, getAgent, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { getFileNameFromResponse } from '../downloader.js';
import { createOutput } from '../output.js';

export function databaseCommand() {
    return {
        command: 'database [path]',
        describe: 'Handles database',
        builder: (yargs) => {
            return yargs
            .positional('path', {
                describe: 'Path to the .bacpac file',
                default: '.'
            })
            .option('export', {
                alias: 'e',
                type: 'boolean',
                description: 'Exports the solutions database to a .bacpac file at [path]'
            })
            .option('output', {
                choices: ['json'],
                describe: 'Outputs a single JSON response for automation-friendly parsing'
            })
        },
        handler: async (argv) => {
            const output = createOutput({ command: 'database', operation: argv.export ? 'export' : 'unknown', argv });

            try {
                output.verboseLog(`Handling database with path: ${argv.path}`);
                await handleDatabase(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

async function handleDatabase(argv, output) {
    if (!argv.export) {
        throw createCommandError('No operation specified. Use --export.', 400);
    }

    let env = await setupEnv(argv, output);
    let user = await setupUser(argv, env);

    await download(env, user, argv.path, output);
}

async function download(env, user, path, output) {
    output.log('Downloading database');

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/DatabaseDownload`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'content-type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    const header = res.headers.get('Content-Disposition');
    if (!res.ok || !header?.includes('attachment')) {
        throw createCommandError('Database download failed, check the database user has db_backupoperator permissions.', res.ok ? 1 : res.status, await parseJsonSafe(res));
    }

    const filename = getFileNameFromResponse(res, path);
    await fs.promises.mkdir(_path.resolve(path), { recursive: true });
    const filePath = _path.resolve(`${_path.resolve(path)}/${filename}`);
    const fileStream = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
        res.body.pipe(fileStream);
        res.body.on("error", reject);
        fileStream.on("error", reject);
        fileStream.on("finish", resolve);
    });

    output.addData({ type: 'download', filename, filePath });
    output.log(`Finished downloading ${filename}`);
}

async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}
