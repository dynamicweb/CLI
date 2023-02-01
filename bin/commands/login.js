import fetch from 'node-fetch';
import { interactiveEnv, getAgent } from './env.js'
import { updateConfig, getConfig } from './config.js';
import yargsInteractive from 'yargs-interactive';

export function loginCommand() {
    return {
        command: 'login [user]',
        describe: 'If user is specified, changes the current user to the user specified, otherwise fetches an API-key that will be used to upload files and trigger addin installs, this runs with interactive mode',
        builder: (yargs) => {
            return yargs
            .positional('user', {
                describe: 'user'
            })
        },
        handler: (argv) => handleLogin(argv)
    }
}

export async function setupUser(argv, env) {
    let user;
    if (env.users) {
        user = env.users[argv.user] || env.users[env.current.user];
    }
    if (!user) {
        console.log('Current user not set, please login')
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

async function handleLogin(argv) {
    argv.user ? changeUser(argv) : interactiveLogin(argv, {
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
    })
}

export async function interactiveLogin(argv, options) {
    if (argv.verbose) console.info('Now logging in')
    await yargsInteractive()
        .interactive(options)
        .then(async (result) => {
            if (!getConfig().env || !getConfig().env[result.environment] || !getConfig().env[result.environment].host || !getConfig().env[result.environment].protocol) {
                if (!argv.host || !argv.protocol)
                    console.log(`The environment specified is missing parameters, please specify them`)
                await interactiveEnv(argv, {
                    environment: {
                        type: 'input',
                        default: result.environment,
                        prompt: 'never'
                    },
                    protocol: {
                        type: 'input',
                        prompt: 'if-no-arg'
                    },
                    host: {
                        type: 'input',
                        prompt: 'if-no-arg'
                    },
                    interactive: {
                        default: true
                    }
                })
            }
            await loginInteractive(result);
        });
}

async function loginInteractive(result) {
    var protocol = getConfig().env[result.environment].protocol;
    var token = await login(result.username, result.password, result.environment, protocol);
    var apiKey = await getApiKey(token, result.environment, protocol)
    getConfig().env = getConfig().env || {};
    getConfig().env[result.environment].users = getConfig().env[result.environment].users || {};
    getConfig().env[result.environment].users[result.username] = getConfig().env[result.environment].users[result.username] || {};
    getConfig().env[result.environment].users[result.username].apiKey = apiKey;
    getConfig().env[result.environment].current = getConfig().env[result.environment].current || {};
    getConfig().env[result.environment].current.user = result.username;
    updateConfig();
}

async function login(username, password, env, protocol) {
    let data = new URLSearchParams();
    data.append('Username', username);
    data.append('Password', password);
    var res = await fetch(`${protocol}://${getConfig().env[env].host}/Admin/Authentication/Login`, {
        method: 'POST',
        body: data,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        agent: getAgent(protocol)
    });

    if (res.ok) {
        let user = parseCookies(res.headers.get('set-cookie')).user;
        return await getToken(user, env, protocol)
    }
    else {
        console.log(res)
    }
}

function parseCookies (cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;

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

async function getToken(user, env, protocol) {
    var res = await fetch(`${getConfig().env[env].protocol}://${getConfig().env[env].host}/Admin/Authentication/Token`, {
        method: 'GET',
        headers: {
            'cookie': `Dynamicweb.Admin=${user}`
        },
        agent: getAgent(protocol)
    });
    if (res.ok) {
        return (await res.json()).token
    }
}

async function getApiKey(token, env, protocol) {
    let data = {
        'Name': 'addin',
        'Prefix': 'addin',
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
        console.log(await res.json())
    }
}

async function changeUser(argv) {
    getConfig().env[getConfig().current.env].current.user = argv.user;
    updateConfig();
    console.log(`You're now logged in as ${getConfig().env[getConfig().current.env].current.user}`);
}