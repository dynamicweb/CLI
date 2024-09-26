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
    let user = {};
    let askLogin = true;

    if (argv.apiKey) {
        user.apiKey = argv.apiKey;
        askLogin = false;
    }

    if (!user.apiKey && env.users) {
        user = env.users[argv.user] || env.users[env.current.user];
        askLogin = false;
    }

    if (askLogin && argv.host) {
        console.log('Please add an --apiKey to the command as overriding the host requires that.')
        process.exit();
    }
    else if (askLogin) {
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
                if (!argv.host)
                    console.log(`The environment specified is missing parameters, please specify them`)
                await interactiveEnv(argv, {
                    environment: {
                        type: 'input',
                        default: result.environment,
                        prompt: 'never'
                    },
                    host: {
                        describe: 'Enter your host including protocol, i.e "https://yourHost.com":',
                        type: 'input',
                        prompt: 'if-no-arg'
                    },
                    interactive: {
                        default: true
                    }
                })
            }
            await loginInteractive(result, argv.verbose);
        });
}

async function loginInteractive(result, verbose) {
    var protocol = getConfig().env[result.environment].protocol;
    var token = await login(result.username, result.password, result.environment, protocol, verbose);
    if (!token) return;
    var apiKey = await getApiKey(token, result.environment, protocol, verbose)
    if (!apiKey) return;
    getConfig().env = getConfig().env || {};
    getConfig().env[result.environment].users = getConfig().env[result.environment].users || {};
    getConfig().env[result.environment].users[result.username] = getConfig().env[result.environment].users[result.username] || {};
    getConfig().env[result.environment].users[result.username].apiKey = apiKey;
    getConfig().env[result.environment].current = getConfig().env[result.environment].current || {};
    getConfig().env[result.environment].current.user = result.username;
    updateConfig();
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
        agent: getAgent(protocol)
    });

    if (res.ok) {
        console.log(res)
        console.log(res.json())
        let user = parseCookies(res.headers.get('set-cookie')).user;
        if (!user) return;
        return await getToken(user, env, protocol, verbose)
    }
    else {
        if (verbose) console.info(res)
        console.log(`Login attempt failed with username ${username}, please verify its a valid user in your Dynamicweb solution.`)
    }
}

function parseCookies (cookieHeader) {
    const list = {};
    if (!cookieHeader) {
        console.log(`Could not get the necessary information from the login request, please verify its a valid user in your Dynamicweb solution.`)
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

    if (!list.user) {
        console.log(`Could not get the necessary information from the login request, please verify its a valid user in your Dynamicweb solution.`)
    }

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
        console.log(`Could not fetch the token for the logged in user ${user}, please verify its a valid user in your Dynamicweb solution.`)
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
        console.log(`Could not create an API Key for the logged in user, please verify its a valid user in your Dynamicweb solution.`)
    }
}

async function changeUser(argv) {
    getConfig().env[getConfig().current.env].current.user = argv.user;
    updateConfig();
    console.log(`You're now logged in as ${getConfig().env[getConfig().current.env].current.user}`);
}