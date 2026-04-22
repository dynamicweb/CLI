import fetch from 'node-fetch';
import { interactiveEnv, getAgent, isJsonOutput, createCommandError } from './env.js'
import { updateConfig, getConfig } from './config.js';
import { input, password } from '@inquirer/prompts';

const DEFAULT_OAUTH_TOKEN_PATH = '/Admin/OAuth/token';
const DEFAULT_CLIENT_ID_ENV = 'DW_CLIENT_ID';
const DEFAULT_CLIENT_SECRET_ENV = 'DW_CLIENT_SECRET';

export function loginCommand() {
    return {
        command: 'login [user]',
        describe: 'If user is specified, changes the current user to the user specified, otherwise fetches an API-key that will be used to upload files and trigger addin installs, this runs with interactive mode',
        builder: (yargs) => {
            return yargs
            .positional('user', {
                describe: 'user'
            })
            .option('oauth', {
                type: 'boolean',
                describe: 'Configures OAuth client_credentials authentication for the current environment'
            })
            .option('output', {
                choices: ['json'],
                describe: 'Outputs a single JSON response for automation-friendly parsing'
            })
        },
        handler: async (argv) => {
            const output = createLoginOutput(argv);

            try {
                await handleLogin(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

export async function setupUser(argv, env) {
    let user = {};
    let askLogin = true;

    if (argv.apiKey) {
        user.apiKey = argv.apiKey;
        askLogin = false;
    }

    if (!user.apiKey && shouldUseOAuth(argv, env)) {
        return await authenticateWithOAuth(argv, env);
    }

    if (!user.apiKey && env.users && (argv.user || env.current?.user)) {
        user = env.users[argv.user] || env.users[env.current?.user];
        askLogin = false;
    }

    if (askLogin && argv.host) {
        throw createCommandError('Please add an --apiKey, or provide OAuth client credentials when overriding the host.');
    }
    else if (askLogin) {
        if (isJsonOutput(argv)) {
            throw createCommandError('Current user not set, please login');
        }

        logMessage(argv, 'Current user not set, please login');
        await interactiveLogin(argv, {
            environment: {
                type: 'input',
                default: getConfig()?.current?.env,
                prompt: 'never'
              },
              username: { 
                type: 'input'
              },
              password: { 
                type: 'password'
              },
              interactive: {
                  default: true
              }
        })
        user = env.users[env.current.user];
    }

    return user;
}

async function handleLogin(argv, output) {
    if (shouldUseOAuth(argv, getCurrentEnv(argv))) {
        if (isJsonOutput(argv)) {
            output.addData(await nonInteractiveOAuthLogin(argv));
        } else {
            output.addData(await interactiveOAuthLogin(argv, output));
        }
    } else if (argv.user) {
        output.addData(await changeUser(argv));
    } else {
        if (isJsonOutput(argv)) {
            throw createCommandError('Interactive login is not supported with --output json. Use --apiKey, or configure OAuth with --oauth --clientIdEnv/--clientSecretEnv.');
        }
        output.addData(await interactiveLogin(argv, {
        environment: {
            type: 'input',
            default: getConfig()?.current?.env || 'dev',
            prompt: 'if-no-arg'
          },
          username: {
            type: 'input'
          },
          password: {
            type: 'password'
          },
          interactive: {
              default: true
          }
    }, output))
    }
}

export async function interactiveLogin(argv, options, output) {
    verboseLog(argv, 'Now logging in');
    const result = {};
    for (const [key, config] of Object.entries(options)) {
        if (key === 'interactive') continue;
        if (config.prompt === 'never') {
            result[key] = config.default;
            continue;
        }
        const promptFn = config.type === 'password' ? password : input;
        result[key] = await promptFn({
            message: config.describe || key,
            default: config.default,
            mask: config.type === 'password' ? '*' : undefined
        });
    }
    if (!getConfig().env || !getConfig().env[result.environment] || !getConfig().env[result.environment].host || !getConfig().env[result.environment].protocol) {
        if (argv.host) {
            ensureEnvironmentFromArgs(result.environment, argv);
        } else {
            logMessage(argv, `The environment specified is missing parameters, please specify them`);
            await interactiveEnv(argv, {
                environment: {
                    type: 'input',
                    default: result.environment,
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
        }
    }
    return await loginInteractive(result, argv.verbose, argv);
}

async function loginInteractive(result, verbose, argv) {
    var protocol = getConfig().env[result.environment].protocol;
    var token = await login(result.username, result.password, result.environment, protocol, verbose);
    if (!token) {
        throw createCommandError(`Could not fetch a login token for user ${result.username}.`);
    }
    var apiKey = await getApiKey(token, result.environment, protocol, verbose)
    if (!apiKey) {
        throw createCommandError(`Could not create an API Key for the logged in user ${result.username}.`);
    }
    getConfig().env = getConfig().env || {};
    getConfig().env[result.environment].users = getConfig().env[result.environment].users || {};
    getConfig().env[result.environment].users[result.username] = getConfig().env[result.environment].users[result.username] || {};
    getConfig().env[result.environment].users[result.username].apiKey = apiKey;
    getConfig().env[result.environment].current = getConfig().env[result.environment].current || {};
    getConfig().env[result.environment].current.user = result.username;
    getConfig().env[result.environment].current.authType = 'user';
    logMessage(argv, "You're now logged in as " + result.username);
    updateConfig();

    return {
        environment: result.environment,
        username: result.username,
        apiKey,
        host: getConfig().env[result.environment].host,
        protocol
    };
}

async function login(username, password, env, protocol, verbose) {
    let data = new URLSearchParams();
    data.append('Username', username);
    data.append('Password', password);
    var res = await fetch(`${protocol}://${getConfig().env[env].host}/Admin/Authentication/Login`, {
        method: 'POST',
        body: data,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        agent: getAgent(protocol),
        redirect: "manual"
    });

    if (res.ok || res.status == 302) {
        let user = parseCookies(res.headers.get('set-cookie')).user;
        if (!user) return;
        return await getToken(user, env, protocol, verbose)
    }
    else {
        if (verbose) console.info(res)
        throw createCommandError(`Login attempt failed with username ${username}, please verify its a valid user in your Dynamicweb solution.`, res.status)
    }
}

export function parseCookies (cookieHeader) {
    const list = {};
    if (!cookieHeader) {
        return list;
    }

    cookieHeader.replace('httponly, ', '').replace('Dynamicweb.Admin', 'user').split(`;`).forEach(cookie => {
        let [ name, ...rest] = cookie.split(`=`);
        name = name?.trim();
        if (!name) return;
        const value = rest.join(`=`).trim();
        if (!value) return;
        list[name] = decodeURIComponent(value);
    });

    return list;
}

async function getToken(user, env, protocol, verbose) {
    var res = await fetch(`${protocol}://${getConfig().env[env].host}/Admin/Authentication/Token`, {
        method: 'GET',
        headers: {
            'cookie': `Dynamicweb.Admin=${user}`
        },
        agent: getAgent(protocol)
    });
    if (res.ok) {
        return (await res.json()).token
    }
    else {
        if (verbose) console.info(res)
        throw createCommandError(`Could not fetch the token for the logged in user ${user}, please verify its a valid user in your Dynamicweb solution.`, res.status)
    }
}

async function getApiKey(token, env, protocol, verbose) {
    let data = {
        'Name': 'DW CLI',
        'Prefix': 'CLI',
        'Description': 'Auto-generated ApiKey by DW CLI'
    };
    var res = await fetch(`${protocol}://${getConfig().env[env].host}/Admin/Api/ApiKeySave`, {
        method: 'POST',
        body: JSON.stringify( { 'model': data } ),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        agent: getAgent(protocol)
    });

    if (res.ok) {
        return (await res.json()).message
    }
    else {
        if (verbose) console.info(res)
        throw createCommandError(`Could not create an API Key for the logged in user, please verify its a valid user in your Dynamicweb solution.`, res.status)
    }
}

async function changeUser(argv) {
    if (!getConfig().current?.env || !getConfig().env?.[getConfig().current.env]) {
        throw createCommandError('Current environment not set, please set it before changing user.');
    }

    getConfig().env[getConfig().current.env].current = getConfig().env[getConfig().current.env].current || {};
    getConfig().env[getConfig().current.env].current.user = argv.user;
    getConfig().env[getConfig().current.env].current.authType = 'user';
    updateConfig();
    logMessage(argv, `You're now logged in as ${getConfig().env[getConfig().current.env].current.user}`);

    return {
        environment: getConfig().current.env,
        username: getConfig().env[getConfig().current.env].current.user
    };
}

async function interactiveOAuthLogin(argv, output) {
    verboseLog(argv, 'Configuring OAuth client credentials authentication');

    const currentEnvName = getConfig()?.current?.env || 'dev';
    const environment = await input({
        message: 'environment',
        default: currentEnvName
    });
    const existingEnv = getConfig()?.env?.[environment] || {};
    const existingAuth = existingEnv.auth || {};

    const result = {
        environment,
        clientIdEnv: argv.clientIdEnv || existingAuth.clientIdEnv || DEFAULT_CLIENT_ID_ENV,
        clientSecretEnv: argv.clientSecretEnv || existingAuth.clientSecretEnv || DEFAULT_CLIENT_SECRET_ENV
    };

    if (!argv.clientIdEnv) {
        result.clientIdEnv = await input({
            message: 'clientIdEnv',
            default: result.clientIdEnv
        });
    }

    if (!argv.clientSecretEnv) {
        result.clientSecretEnv = await input({
            message: 'clientSecretEnv',
            default: result.clientSecretEnv
        });
    }

    if (argv.host) {
        ensureEnvironmentFromArgs(result.environment, argv);
    } else if (!getConfig().env || !getConfig().env[result.environment] || !getConfig().env[result.environment].host || !getConfig().env[result.environment].protocol) {
        logMessage(argv, 'The environment specified is missing parameters, please specify them');
        await interactiveEnv(argv, {
            environment: {
                type: 'input',
                default: result.environment,
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
        }, output);
    }

    const oauthResult = await finalizeOAuthLogin(result.environment, result.clientIdEnv, result.clientSecretEnv, argv);

    logMessage(argv, `OAuth authentication is now configured for ${result.environment}`);

    return oauthResult;
}

async function nonInteractiveOAuthLogin(argv) {
    verboseLog(argv, 'Configuring OAuth client credentials authentication (non-interactive)');

    let environment = getConfig()?.current?.env;

    if (!environment && argv.host) {
        environment = new URL(`https://${argv.host.replace(/^https?:\/\//, '')}`).hostname.split('.')[0] || 'default';
    }

    if (!environment) {
        throw createCommandError('No environment set. Configure one with "dw env" first, or pass --host.');
    }

    if (argv.host) {
        ensureEnvironmentFromArgs(environment, argv);
    } else if (!getConfig().env?.[environment]?.host) {
        throw createCommandError(`Environment "${environment}" has no host configured. Pass --host or set it up with "dw env" first.`);
    }

    const clientIdEnv = argv.clientIdEnv || getConfig().env?.[environment]?.auth?.clientIdEnv || DEFAULT_CLIENT_ID_ENV;
    const clientSecretEnv = argv.clientSecretEnv || getConfig().env?.[environment]?.auth?.clientSecretEnv || DEFAULT_CLIENT_SECRET_ENV;

    return await finalizeOAuthLogin(environment, clientIdEnv, clientSecretEnv, argv);
}

async function finalizeOAuthLogin(environment, clientIdEnv, clientSecretEnv, argv) {
    const env = getConfig().env?.[environment];
    if (!env) {
        throw createCommandError(`Environment "${environment}" is not configured. Run "dw env" first or pass --host.`);
    }
    const oauthConfig = resolveOAuthConfig({
        ...argv,
        clientIdEnv,
        clientSecretEnv,
        oauth: true
    }, env);

    const tokenResult = await fetchOAuthToken(env, oauthConfig, argv.verbose);

    getConfig().current = getConfig().current || {};
    getConfig().current.env = environment;
    env.auth = {
        type: 'oauth_client_credentials',
        clientIdEnv,
        clientSecretEnv
    };
    env.current = env.current || {};
    env.current.authType = 'oauth_client_credentials';
    delete env.current.user;
    updateConfig();

    return {
        environment,
        authType: 'oauth_client_credentials',
        clientIdEnv,
        clientSecretEnv,
        expires: tokenResult.expires || null
    };
}

async function authenticateWithOAuth(argv, env) {
    const oauthConfig = resolveOAuthConfig(argv, env, true);
    const tokenResult = await fetchOAuthToken(env, oauthConfig, argv.verbose);

    return {
        apiKey: tokenResult.token,
        authType: 'oauth_client_credentials',
        expires: tokenResult.expires || null
    };
}

export function shouldUseOAuth(argv, env = {}) {
    if (argv.auth === 'user') {
        return false;
    }

    if (argv.oauth || argv.auth === 'oauth') {
        return true;
    }

    if (argv.clientId || argv.clientSecret || argv.clientIdEnv || argv.clientSecretEnv) {
        return true;
    }

    if (env?.current?.authType) {
        return env.current.authType === 'oauth_client_credentials';
    }

    return env?.auth?.type === 'oauth_client_credentials';
}

export function resolveOAuthConfig(argv, env = {}, requireCredentials = true) {
    const authConfig = env?.auth || {};
    const clientIdEnv = argv.clientIdEnv || authConfig.clientIdEnv || DEFAULT_CLIENT_ID_ENV;
    const clientSecretEnv = argv.clientSecretEnv || authConfig.clientSecretEnv || DEFAULT_CLIENT_SECRET_ENV;
    const clientId = argv.clientId || process.env[clientIdEnv];
    const clientSecret = argv.clientSecret || process.env[clientSecretEnv];

    if (requireCredentials) {
        if (!clientId) {
            throw createCommandError(`OAuth client ID not found. Set --clientId or export ${clientIdEnv}.`);
        }

        if (!clientSecret) {
            throw createCommandError(`OAuth client secret not found. Set --clientSecret or export ${clientSecretEnv}.`);
        }
    }

    return {
        clientId,
        clientSecret,
        clientIdEnv,
        clientSecretEnv
    };
}

async function fetchOAuthToken(env, oauthConfig, verbose) {
    const res = await fetch(`${env.protocol}://${env.host}${DEFAULT_OAUTH_TOKEN_PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: oauthConfig.clientId,
            client_secret: oauthConfig.clientSecret
        }),
        agent: getAgent(env.protocol)
    });

    const body = await parseJsonSafe(res);

    if (!res.ok) {
        if (verbose) {
            console.info(res);
        }

        throw createCommandError(`OAuth token request failed at ${DEFAULT_OAUTH_TOKEN_PATH}.`, res.status, body);
    }

    const token = body?.token || body?.Token;
    const expires = body?.expires || body?.Expires || null;

    if (!token) {
        throw createCommandError('OAuth token response did not include a token.', res.status, body);
    }

    return { token, expires };
}

function getCurrentEnv(argv) {
    if (argv.host) {
        return {
            host: argv.host,
            protocol: argv.protocol || 'https'
        };
    }

    return getConfig()?.env?.[getConfig()?.current?.env] || {};
}

function ensureEnvironmentFromArgs(environment, argv) {
    getConfig().env = getConfig().env || {};
    getConfig().env[environment] = getConfig().env[environment] || {};
    getConfig().env[environment].host = argv.host;
    getConfig().env[environment].protocol = argv.protocol || 'https';
    getConfig().current = getConfig().current || {};
    getConfig().current.env = environment;
    updateConfig();
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

function createLoginOutput(argv) {
    const response = {
        ok: true,
        command: 'login',
        operation: shouldUseOAuth(argv, getCurrentEnv(argv)) ? 'oauth-login' : argv.user ? 'select-user' : 'login',
        status: 200,
        data: [],
        errors: [],
        meta: {}
    };

    return {
        json: isJsonOutput(argv),
        addData(entry) {
            response.data.push(entry);
        },
        fail(err) {
            response.ok = false;
            response.status = err?.status || 1;
            response.errors.push({
                message: err?.message || 'Unknown login command error.',
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
