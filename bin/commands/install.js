import fetch from 'node-fetch';
import path from 'path';
import { setupEnv, getAgent, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { uploadFiles, resolveFilePath } from './files.js';
import { createOutput } from '../output.js';
import { resolveTransfer } from '../transfer/index.js';

export function installCommand() {
    return {
        command: 'install <filePath>',
        describe: 'Installs the addin on the given path, allowed file extensions are .dll, .nupkg',
        builder: (yargs) => {
            return yargs
                .positional('filePath', {
                    describe: 'Path to the file to install'
                })
                .option('queue', {
                    alias: 'q',
                    type: 'boolean',
                    describe: 'Queues the install for next Dynamicweb recycle'
                })
                .option('output', {
                    choices: ['json'],
                    describe: 'Outputs a single JSON response for automation-friendly parsing'
                })
        },
        handler: async (argv) => {
            const output = createInstallOutput(argv);

            try {
                output.verboseLog(`Installing file located at: ${argv.filePath}`);
                await handleInstall(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

async function handleInstall(argv, output) {
    let env = await setupEnv(argv, output);
    let user = await setupUser(argv, env);
    let resolvedPath = resolveFilePath(argv.filePath);
    const transfer = await resolveTransfer(argv, env, user, output);
    await uploadFiles(env, user, [resolvedPath], 'System/AddIns/Local', false, true, output, transfer);
    await installAddin(env, user, resolvedPath, argv.queue, output);
}

async function installAddin(env, user, resolvedPath, queue, output) {
    output.log('Installing addin');
    let filename = path.basename(resolvedPath);
    let data = {
        'Queue': queue,
        'Ids': [
            `${filename.substring(0, filename.lastIndexOf('.')) || filename}|${path.extname(resolvedPath)}`
        ]
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    let res;
    try {
        res = await fetch(`${env.protocol}://${env.host}/Admin/Api/AddinInstall`, {
            method: 'POST',
            body: JSON.stringify(data),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${user.apiKey}`
            },
            agent: getAgent(env.protocol),
            signal: controller.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw createCommandError('Addin installation request timed out.', 408);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }

    if (res.ok) {
        const body = await parseJsonSafe(res);
        output.verboseLog(body);
        output.addData({
            type: 'install',
            filePath: resolvedPath,
            filename,
            queued: Boolean(queue),
            response: body
        });
        output.log('Addin installed');
    } else {
        const body = await parseJsonSafe(res);
        throw createCommandError('Addin installation failed.', res.status, body);
    }
}

export function createInstallOutput(argv) {
    return createOutput({
        command: 'install',
        operation: argv.queue ? 'queue' : 'install',
        argv,
        meta: { filePath: argv.filePath }
    });
}

async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}
