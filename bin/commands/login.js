import fetch from 'node-fetch';
import { interactiveEnv } from './env.js'
import { updateConfig, getConfig } from './config.js';
import yargsInteractive from 'yargs-interactive';
import { Agent } from 'https';

const agent = new Agent({
    rejectUnauthorized: false
})

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
            if (!getConfig().env || !getConfig().env[result.environment] || !getConfig().env[result.environment].host) {
                if (!argv.host)
                    console.log(`The environment specified is missing parameters, please specify them`)
                await interactiveEnv(argv, {
                    environment: {
                        type: 'input',
                        default: result.environment,
                        prompt: 'never'
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
    var token = await login(result.username, result.password, result.environment);
    var apiKey = await getApiKey(token, result.environment)
    getConfig().env = getConfig().env || {};
    getConfig().env[result.environment].users = getConfig().env[result.environment].users || {};
    getConfig().env[result.environment].users[result.username] = getConfig().env[result.environment].users[result.username] || {};
    getConfig().env[result.environment].users[result.username].apiKey = apiKey;
    getConfig().env[result.environment].current = getConfig().env[result.environment].current || {};
    getConfig().env[result.environment].current.user = result.username;
    updateConfig();
}

async function login(username, password, env) {
    let data = new URLSearchParams();
    data.append('Username', username);
    data.append('Password', password);
    var res = await fetch(`https://${getConfig().env[env].host}/Admin/Authentication/Login`, {
        method: 'POST',
        body: data,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        agent: agent
    });

    if (res.ok) {
        let user = parseCookies(res.headers.get('set-cookie')).user;
        return await getToken(user, env)
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

async function getToken(user, env) {
    var res = await fetch(`https://${getConfig().env[env].host}/Admin/Authentication/Token`, {
        method: 'GET',
        headers: {
            'cookie': `Dynamicweb.Admin=${user}`
        },
        agent: agent
    });
    if (res.ok) {
        return (await res.json()).token
    }
}

async function getApiKey(token, env) {
    let data = new URLSearchParams();
    data.append('Name', 'addin');
    data.append('Prefix', 'addin');
    data.append('Description', 'Auto-generated ApiKey by DW CLI');
    var res = await fetch(`https://${getConfig().env[env].host}/Admin/Api/ApiKeySave`, {
        method: 'POST',
        body: data,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Bearer ${token}`
        },
        agent: agent
    });

    if (res.ok) {
        return (await res.json()).message
    }
    else {
        console.log(res)
    }
}

async function changeUser(argv) {
    getConfig().env[getConfig().current.env].current.user = argv.user;
    updateConfig();
    console.log(`You're now logged in as ${getConfig().env[getConfig().current.env].current.user}`);
}