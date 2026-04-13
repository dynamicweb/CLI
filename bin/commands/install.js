import fetch from 'node-fetch';
import path from 'path';
import { setupEnv, getAgent, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { uploadFiles, resolveFilePath } from './files.js';

export function installCommand() {
    return {
        command: 'install [filePath]',
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
    await uploadFiles(env, user, [ resolvedPath ], 'System/AddIns/Local', false, true, output);
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
    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/AddinInstall`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    });

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

function createInstallOutput(argv) {
    const response = {
        ok: true,
        command: 'install',
        operation: argv.queue ? 'queue' : 'install',
        status: 200,
        data: [],
        errors: [],
        meta: {
            filePath: argv.filePath
        }
    };

    return {
        json: argv.output === 'json',
        response,
        log(...args) {
            if (!this.json) {
                console.log(...args);
            }
        },
        verboseLog(...args) {
            if (argv.verbose && !this.json) {
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
        fail(err) {
            response.ok = false;
            response.status = err?.status || 1;
            response.errors.push({
                message: err?.message || 'Unknown install command error.',
                details: err?.details ?? null
            });
        },
        finish() {
            if (this.json) {
                console.log(JSON.stringify(response, null, 2));
            }
        }
    };
}


async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}
