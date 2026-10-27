import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { setupEnv, getAgent, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { isRemoteParam, redactUrl } from '../utils.js';
import { createOutput } from '../output.js';

const exclude = ['_', '$0', 'command', 'list', 'json', 'verbose', 'v', 'host', 'protocol', 'apiKey', 'env', 'output', 'auth', 'clientId', 'clientSecret', 'clientIdEnv', 'clientSecretEnv', 'oauth', 'transfer']
const isCommandParam = isRemoteParam(exclude)

export function commandCommand() {
    return {
        command: 'command [command]',
        describe: 'Runs the given command',
        builder: (yargs) => {
            return yargs
                .positional('command', {
                    describe: 'The command to execute'
                })
                .option('json', {
                    describe: 'Literal json or location of json file to send'
                })
                .option('list', {
                    alias: 'l',
                    describe: 'Lists all the properties for the command, currently not working'
                })
                .option('output', {
                    choices: ['json'],
                    describe: 'Outputs a single JSON response for automation-friendly parsing'
                })
        },
        handler: async (argv) => {
            const output = createCommandOutput(argv);

            try {
                output.verboseLog(`Running command ${argv.command}`);
                await handleCommand(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

async function handleCommand(argv, output) {
    let env = await setupEnv(argv, output);
    let user = await setupUser(argv, env);
    if (argv.list) {
        const properties = await getProperties(env, user, argv.command);
        output.addData(properties);
        output.log(properties);
    } else {
        let response = await runCommand(env, user, argv.command, getQueryParams(argv), parseJsonOrPath(argv.json));
        output.addData(response);
        output.log(response);
    }
}

async function getProperties(env, user, command) {
    throw createCommandError('The --list option is not currently implemented for commands.');
}

export function getQueryParams(argv) {
    let params = {}
    Object.keys(argv).filter(isCommandParam).forEach(k => params['Command.' + k] = argv[k])
    return params
}

export function parseJsonOrPath(json) {
    if (!json) return
    const trimmed = json.trim();
    const literal = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (!literal && !fs.existsSync(json)) {
        throw createCommandError(`--json must be literal JSON or the path to a JSON file; "${json}" is neither.`, 400);
    }
    try {
        return JSON.parse(literal ? trimmed : fs.readFileSync(path.resolve(json), 'utf8'));
    } catch (err) {
        throw createCommandError(`Invalid JSON payload${literal ? '' : ` in ${json}`}: ${err.message}`, 400);
    }
}

async function runCommand(env, user, command, queryParams, data) {
    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/${command}?` + new URLSearchParams(queryParams), {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    })
    if (!res.ok) {
        throw createCommandError(`Error when doing request ${redactUrl(res.url)}`, res.status, await parseJsonSafe(res));
    }
    return await res.json()
}

function createCommandOutput(argv) {
    return createOutput({
        command: 'command',
        operation: argv.list ? 'list' : 'run',
        argv,
        meta: { commandName: argv.command }
    });
}

async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}
