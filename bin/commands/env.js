import { updateConfig, getConfig } from './config.js'
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { input } from '@inquirer/prompts';
import { createOutput } from '../output.js';

const httpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: 8,
    maxFreeSockets: 4,
    keepAliveMsecs: 10_000
});

const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 8,
    maxFreeSockets: 4,
    keepAliveMsecs: 10_000,
    rejectUnauthorized: false
});

export function getAgent(protocol) {
    return protocol === 'http' ? httpAgent : httpsAgent;
}

export function parseHostInput(hostValue) {
    if (!hostValue || typeof hostValue !== 'string' || !hostValue.trim()) {
        throw createCommandError(`Invalid host value: ${hostValue}`);
    }
    hostValue = hostValue.trim();
    const hostSplit = hostValue.split('://');
    if (hostSplit.length > 2) {
        throw createCommandError(`Issues resolving host ${hostValue}`);
    }

    // Parse it as a URL so a trailing slash, letter case or a default port can't produce
    // a different host, which would break the request URLs and split the transfer state.
    let parsed;
    try {
        parsed = new URL(hostSplit.length === 1 ? `https://${hostValue}` : hostValue);
    } catch {
        throw createCommandError(`Issues resolving host ${hostValue}`);
    }

    const protocol = parsed.protocol.replace(/:$/, '');
    if (protocol !== 'http' && protocol !== 'https') {
        throw createCommandError(`Unsupported protocol "${protocol}" in host ${hostValue}, use http or https`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.replace(/\/+$/, '')) {
        throw createCommandError(`The host ${hostValue} must not include a path, query string or credentials`);
    }

    return {
        protocol,
        host: parsed.host
    };
}

/**
 * Normalizes a host value, letting an explicit protocol (e.g. --protocol) win over one
 * written in the host itself.
 */
export function resolveHost(hostValue, protocol) {
    const resolved = parseHostInput(hostValue);
    return {
        host: resolved.host,
        protocol: protocol || resolved.protocol
    };
}

export function envCommand() {
    return {
        command: 'env [env]',
        describe: 'If environment is specified, changes the current environment to the environment specified, otherwise sets up the config for a new environment. Combine [env] with --host to create or update an environment without prompting',
        builder: (yargs) => {
            return yargs
                .positional('env', {
                    describe: 'Environment'
                })
                .option('list', {
                    alias: 'l',
                    type: 'boolean',
                    description: 'List all existing environments'
                })
                .option('users', {
                    alias: 'u',
                    type: 'boolean',
                    description: 'List all users in environment, uses positional [env] if used, otherwise current env'
                })
                .option('output', {
                    choices: ['json'],
                    describe: 'Outputs a single JSON response for automation-friendly parsing'
                })
        },
        handler: async (argv) => {
            const output = createEnvOutput(argv);

            try {
                await handleEnv(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

export async function setupEnv(argv, output = null, deps = {}) {
    const interactiveEnvFn = deps.interactiveEnvFn || interactiveEnv;
    const cfg = getConfig();
    let env = {};
    let askEnv = true;

    if (argv.host) {
        askEnv = false;
        env = resolveHost(argv.host, argv.protocol);
    }

    if (askEnv && cfg.env) {
        env = cfg.env[argv.env] || cfg.env[cfg?.current?.env];
        if (env && !env.protocol) {
            logMessage(argv, 'Protocol for environment not set, defaulting to https');
            env.protocol = 'https';
        }
    }
    else if (askEnv) {
        if (isJsonOutput(argv)) {
            throw createCommandError('Current environment not set, please set it');
        }

        logMessage(argv, 'Current environment not set, please set it');
        await interactiveEnvFn(argv, {
            environment: {
                type: 'input'
            },
            interactive: {
                default: true
            }
        }, output)
        const updatedConfig = getConfig();
        env = updatedConfig.env?.[updatedConfig?.current?.env];
    }

    if (!env || Object.keys(env).length === 0) {
        throw createCommandError('Unable to resolve the current environment.');
    }

    // Hosts saved before they were normalized may still carry a protocol or a trailing slash.
    if (env.host) {
        Object.assign(env, resolveHost(env.host, env.protocol));
    }

    return env;
}

async function handleEnv(argv, output) {
    if (argv.users) {
        const cfg = getConfig();
        let env = argv.env || cfg.current?.env;
        const envConfig = cfg.env?.[env];
        if (!envConfig) {
            throw createCommandError(`Environment '${env}' does not exist`, 404);
        }
        const users = Object.keys(envConfig.users || {});
        output.addData({ environment: env, users });
        output.log(`Users in environment ${env}: ${users}`);
    } else if (argv.env) {
        const result = await changeEnv(argv, output);
        if (result !== null) {
            output.addData(result);
        }
    } else if (argv.list) {
        const environments = Object.keys(getConfig().env || {});
        output.addData({ environments });
        output.log(`Existing environments: ${environments}`);
    } else {
        if (isJsonOutput(argv)) {
            throw createCommandError('Interactive environment setup is not supported with --output json. Use "dw env <name> --host <host>" instead.', 400);
        }
        await interactiveEnv(argv, {
            environment: {
                type: 'input'
            },
            host: {
                describe: 'Enter your host including protocol, i.e "https://yourHost.com":',
                type: 'input'
            },
            interactive: {
                default: true
            }
        }, output)
    }
}

export async function interactiveEnv(argv, options, output) {
    verboseLog(argv, 'Setting up new environment');
    const result = {};
    for (const [key, config] of Object.entries(options)) {
        if (key === 'interactive') continue;
        if (config.prompt === 'never') {
            result[key] = config.default;
            continue;
        }
        result[key] = await input({
            message: config.describe || key,
            default: config.default
        });
    }
    getConfig().env = getConfig().env || {};
    if (!result.environment || !result.environment.trim()) {
        throw createCommandError('Environment name cannot be empty');
    }
    getConfig().env[result.environment] = getConfig().env[result.environment] || {};
    if (result.host) {
        const resolvedHost = parseHostInput(result.host);
        getConfig().env[result.environment].protocol = resolvedHost.protocol;
        getConfig().env[result.environment].host = resolvedHost.host;
    }
    if (result.environment) {
        getConfig().current = getConfig().current || {};
        getConfig().current.env = result.environment;
    }
    updateConfig();
    logMessage(argv, `Your current environment is now ${getConfig().current.env}`);
    logMessage(argv, `To change the host of your environment, use the command 'dw env'`);

    const currentEnv = getConfig().env[result.environment];
    const data = {
        environment: result.environment,
        protocol: currentEnv.protocol || null,
        host: currentEnv.host || null,
        current: getConfig().current.env
    };

    if (output) {
        output.addData(data);
    }

    return data;
}

async function changeEnv(argv, output) {
    const config = getConfig();
    config.env = config.env || {};

    if (argv.host) {
        const env = config.env[argv.env] = config.env[argv.env] || {};
        Object.assign(env, resolveHost(argv.host, argv.protocol));
    } else if (!Object.hasOwn(config.env, argv.env)) {
        if (isJsonOutput(argv)) {
            throw createCommandError(`The specified environment ${argv.env} doesn't exist, please create it with "dw env ${argv.env} --host <host>"`, 404);
        }

        logMessage(argv, `The specified environment ${argv.env} doesn't exist, please create it`);
        await interactiveEnv(argv, {
            environment: {
                type: 'input',
                default: argv.env,
                prompt: 'never'
            },
            host: {
                describe: 'Enter your host including protocol, i.e "https://yourHost.com":',
                type: 'input',
                prompt: 'always'
            },
            interactive: {
                default: true
            }
        }, output)
        return null;
    }

    config.current = config.current || {};
    config.current.env = argv.env;
    updateConfig();
    const env = config.env[argv.env];
    const data = {
        environment: argv.env,
        protocol: env.protocol || null,
        host: env.host || null,
        current: config.current.env
    };
    logMessage(argv, `Your current environment is now ${config.current.env}`);
    if (output) {
        output.addData(data);
    }
    return null;
}

export function isJsonOutput(argv) {
    return argv?.output === 'json';
}

export function createCommandError(message, status = 1, details = null) {
    const error = new Error(message);
    error.status = status;
    error.details = details;
    return error;
}

function logMessage(argv, ...args) {
    if (!isJsonOutput(argv)) {
        console.log(...args);
    }
}

function verboseLog(argv, ...args) {
    if (argv?.verbose && !isJsonOutput(argv)) {
        console.info(...args);
    }
}

function createEnvOutput(argv) {
    return createOutput({
        command: 'env',
        operation: argv.users ? 'users' : argv.list ? 'list' : argv.env ? 'select' : 'setup',
        argv
    });
}
