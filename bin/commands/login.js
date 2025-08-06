import fetch from 'node-fetch';
import { interactiveEnv, getAgent } from './env.js'
import { updateConfig, getConfig } from './config.js';
import yargsInteractive from 'yargs-interactive';

const AuthMethods = {
    Normal: 'Normal',
    TOTP: 'TOTP (Time-based One-time Password)',
    Link: 'Passwordless Authentication with Magic Links',
    MFA: 'Multi Factor Authentication (MFA)'
};

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

/**
 * Retrieves the current user's configuration, ensuring they are authenticated.
 * If no user is configured, it triggers the interactive login process.
 *
 * @param {object} argv - The command-line arguments.
 * @param {object} env - The configuration object for the current environment.
 * @returns {Promise<object>} The user object containing the apiKey.
 */
export async function setupUser(argv, env) {
    if (argv.apiKey) {
        return { apiKey: argv.apiKey };
    }

    if (env.users) {
        const activeUser = env.users[argv.user] || env.users[env.current?.user];

        if (activeUser?.apiKey) {
            return activeUser;
        }
    }
    
    if (argv.host) {
        console.log('Please add an --apiKey to the command as overriding the host requires that.')
        process.exit();
    }

    console.log('Current user not set, please login.');
    await interactiveLogin(argv, {
        method: {
            type: 'list',
            describe: 'Select authentication method',
            choices: Object.values(AuthMethods)
        },
        environment: {
            type: 'input',
            default: getConfig()?.current?.env,
            prompt: 'never'
        },
        username: {
            type: 'input'
        },
        password: {
            type: 'password',
            when: (answers) => answers.method === AuthMethods.Normal || answers.method === AuthMethods.MFA
        },
        interactive: {
            default: true
        }
    });

    const updatedConfig = getConfig();
    const updatedEnv = updatedConfig.env[updatedConfig.current.env];
    const user = updatedEnv.users[updatedEnv.current.user];

    if (!user?.apiKey) {
        console.error("Login seemed successful, but failed to retrieve user data. Please try again.");
        process.exit();
    }

    return user;
}

async function handleLogin(argv) {
    argv.user ? changeUser(argv) : interactiveLogin(argv, {
        method: {
            type: 'list',
            describe: 'Select authentication method',
            choices: Object.values(AuthMethods)
        },
        environment: {
            type: 'input',
            default: getConfig()?.current?.env || 'dev',
            prompt: 'if-no-arg'
        },
        username: {
            type: 'input'
        },
        password: {
            type: 'password',
            when: (answers) => answers.method === AuthMethods.Normal || answers.method === AuthMethods.MFA
        },
        interactive: {
            default: true
        }
    })
}

/**
 * Manages the interactive login session.
 * It first prompts the user for login details (method, username, etc.).
 * Then, it ensures the selected environment is fully configured before proceeding to the actual login logic.
 * @param {object} argv - The command-line arguments.
 * @param {object} options - The configuration for the yargs-interactive prompt.
 * @returns {Promise<void>}
 */
export async function interactiveLogin(argv, options) {
    if (argv.verbose) {
        console.info('Now logging in');
    }

    const result = await yargsInteractive().interactive(options);

    const config = getConfig();
    const envConfig = config.env?.[result.environment];
    const isEnvIncomplete = !envConfig || !envConfig.host || !envConfig.protocol;

    if (isEnvIncomplete) {
        if (!argv.host) {
            console.log(`The environment specified is missing parameters, please specify them`)
        }

        const envSetupOptions = {
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
        };

        await interactiveEnv(argv, envSetupOptions);
    }

    await loginInteractive(result, argv.verbose);
}

/**
 * Handles the interactive login flow after collecting user input.
 * It authenticates the user, retrieves an API key, and updates the local configuration.
 * @param {object} result - The user input from yargs-interactive, including environment, username, etc.
 * @param {boolean} verbose - Flag for verbose logging.
 * @returns {Promise<void>}
 */
async function loginInteractive(result, verbose) {
    const { environment, username } = result;

    const config = getConfig();
    const envConfig = config.env[environment];
    const protocol = envConfig.protocol;

    const token = await login(result, protocol, verbose);
    if (!token) {
        console.error("Login failed: Could not retrieve an authentication token.");
        return;
    }

    const apiKey = await getApiKey(token, environment, protocol, verbose);
    if (!apiKey) {
        console.error("Failed to retrieve or generate an API key after login.");
        return;
    }

    envConfig.users = envConfig.users || {};
    envConfig.users[username] = { apiKey: apiKey };
    envConfig.current = { user: username };

    updateConfig();

    console.log(`You're now logged in as '${username}' for the '${environment}' environment.`);
}

/**
 * Calls the required authentication method.
 * @param {object} options - Object with data from user (method, username, password, environment).
 * @param {string} protocol - Protocol (http/https).
 * @param {boolean} verbose - True if logging is needed.
 * @returns {Promise<string|undefined>} Authentication token.
 */
async function login(options, protocol, verbose) {
    const { method, username, password, environment: env } = options;

    switch (method) {
        case AuthMethods.Normal:
            return await loginWithPassword({ username, password, env, protocol, verbose });

        case AuthMethods.MFA:
            return await loginWithMFA({ username, password, env, protocol, verbose });

        case AuthMethods.TOTP:
            return await loginWithCode({ username, env, protocol, verbose });

        case AuthMethods.Link:
            return await loginWithLink({ username, env, protocol, verbose });

        default:
            console.error(`Unknown authentication method: ${method}`);
            return;
    }
}

/**
 * Performs the common, sequential steps for authentication by username and password.
 * This involves two requests: first to submit the username to initiate a session, 
 * and second to submit the password using that session's cookie.
 *
 * @param {object} credentials - The user's credentials and environment details.
 * @param {string} credentials.username - The user's username.
 * @param {string} credentials.password - The user's password.
 * @param {string} credentials.env - The target environment name.
 * @param {string} credentials.protocol - The protocol ('http' or 'https').
 * @param {boolean} credentials.verbose - A flag for verbose logging.
 * @returns {Promise<{passwordRequest: Response, sessionCookie: string}|null>} An object with the final response and the session cookie, or null on failure.
 */
async function performUsernamePasswordSteps({ username, password, env, protocol, verbose }) {
    const host = getConfig().env[env].host;
    const baseUrl = `${protocol}://${host}/Admin/Authentication`;
    const loginUrl = `${baseUrl}/Login`;
    const passwordUrl = `${baseUrl}/Login/Password`;

    const requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        agent: getAgent(protocol),
        redirect: 'manual'
    };

    const loginRequest = await fetch(loginUrl, {
        ...requestOptions,
        body: new URLSearchParams({ Username: username })
    });

    if (loginRequest.status !== 302 && !loginRequest.ok) {
        if (verbose) {
            console.info(loginRequest);
        }

        console.log(`Login attempt failed with username ${username}, please verify its a valid user in your Dynamicweb solution.`)
        return null;
    }

    const sessionCookie = loginRequest.headers.get('set-cookie');
    if (!sessionCookie) {
        console.error('Failed to receive a session cookie after submitting the username.');

        if (verbose) {
            console.info(loginRequest);
        }

        return null;
    }

    const passwordRequest = await fetch(passwordUrl, {
        ...requestOptions,
        headers: {
            ...requestOptions.headers,
            'Cookie': sessionCookie
        },
        body: new URLSearchParams({ Password: password })
    });

    if (passwordRequest.status !== 302 && !passwordRequest.ok) {
        if (verbose) {
            console.info(passwordRequest);
        }

        console.log(`Login attempt failed with username ${username}, please verify its a valid user in your Dynamicweb solution.`)
        return null;
    }

    return { passwordRequest, sessionCookie };
}


/**
 * Handles the complete authentication flow for the Normal "Login/Password" method.
 * It utilizes the common steps for username/password submission and then extracts 
 * the final authentication token upon success.
 *
 * @param {object} credentials - The user's credentials and environment details.
 * @param {string} credentials.username - The user's username.
 * @param {string} credentials.password - The user's password.
 * @param {string} credentials.env - The target environment name.
 * @param {string} credentials.protocol - The protocol ('http' or 'https').
 * @param {boolean} credentials.verbose - A flag for verbose logging.
 * @returns {Promise<string|undefined>} The final authentication token, or undefined on failure.
 */
async function loginWithPassword({ username, password, env, protocol, verbose }) {
    const authResult = await performUsernamePasswordSteps({ username, password, env, protocol, verbose });
        
    if (!authResult) {
        return;
    }

    const { passwordRequest } = authResult;
    const userAuthCookieHeader = passwordRequest.headers.get('set-cookie');

    const { user } = parseCookies(userAuthCookieHeader);

    if (!user) {
        console.error("Authentication succeeded, but failed to extract user details from the final cookie.");
        return;
    }

    return await getToken(user, env, protocol, verbose);
}

/**
 * Handles the complete Multi-Factor Authentication (MFA) flow, which consists of
 * three sequential steps: Username -> Password -> One-Time Code.
 * This function orchestrates the process by calling two helper functions in sequence.
 *
 * @param {object} credentials - The user's credentials and environment details.
 * @param {string} credentials.username - The user's username.
 * @param {string} credentials.password - The user's password.
 * @param {string} credentials.env - The target environment name.
 * @param {string} credentials.protocol - The protocol ('http' or 'https').
 * @param {boolean} credentials.verbose - A flag for verbose logging.
 * @returns {Promise<string|undefined>} The final authentication token, or undefined on failure.
 */
async function loginWithMFA({ username, password, env, protocol, verbose }) {   
    const passwordStepResult = await performUsernamePasswordSteps({ username, password, env, protocol, verbose });

    if (!passwordStepResult) {
        return;
    }

    const { sessionCookie } = passwordStepResult;
      
    return await performCodeVerification(sessionCookie, { env, protocol, verbose });
}

/**
 * Prompts the user for a one-time code and performs the final verification step.
 * This function is used by both MFA and Code-only authentication flows.
 *
 * @param {string} sessionCookie - The session cookie received from a previous authentication step.
 * @param {object} options - Environment and logging options.
 * @returns {Promise<string|undefined>} The final API bearer token, or undefined on failure.
 */
async function performCodeVerification(sessionCookie, { env, protocol, verbose }) {
    const promptResult = await yargsInteractive().interactive({
        interactive: { default: true },
        oneTimeCode: {
            type: 'input',
            describe: 'Please enter the one-time code you received:'
        }
    });
   
    const { oneTimeCode } = promptResult;
    if (!oneTimeCode) {
        console.error('A one-time code is required to proceed.');
        return;
    }

    const host = getConfig().env[env].host;
    const verifyUrl = `${protocol}://${host}/Admin/Authentication/Login/VerifyCode`;

    const verifyRequest = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': sessionCookie
        },
        agent: getAgent(protocol),
        redirect: 'manual',
        body: new URLSearchParams({ OneTimeCode: oneTimeCode })
    });

    if (verifyRequest.status !== 302 && !verifyRequest.ok) {
        console.error('The provided one-time code could not be verified. It may be incorrect or expired.');
        if (verbose) {
            console.info('Server response:', await verifyRequest.text().catch(() => 'Could not read body.'));
        }

        return;
    }

    const userAuthCookieHeader = verifyRequest.headers.get('set-cookie');
    const { user } = parseCookies(userAuthCookieHeader);

    if (!user) {
        console.error("Code verification succeeded, but failed to extract user details from the final cookie.");
        return;
    }

    return await getToken(user, env, protocol, verbose);
}

/**
 * Handles the complete authentication flow for the Code-only (TOTP) method.
 *
 * @param {object} credentials - The user's credentials and environment details.
 * @param {string} credentials.username - The user's username.
 * @param {string} credentials.env - The target environment name.
 * @param {string} credentials.protocol - The protocol ('http' or 'https').
 * @param {boolean} credentials.verbose - A flag for verbose logging.
 * @returns {Promise<string|undefined>} The final authentication token, or undefined on failure.
 */
async function loginWithCode({ username, env, protocol, verbose }) {
    const host = getConfig().env[env].host;
    const baseUrl = `${protocol}://${host}/Admin/Authentication`;
    const loginUrl = `${baseUrl}/Login`;

    const loginRequest = await fetch(loginUrl, {
        method: 'POST',
        body: new URLSearchParams({ Username: username }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        agent: getAgent(protocol),
        redirect: 'manual'
    });

    if (loginRequest.status !== 302 && !loginRequest.ok) {
        if (verbose) {
            console.info(loginRequest);
        }

        console.log(`Login attempt failed with username ${username}, please verify its a valid user in your Dynamicweb solution`);
        return;
    }

    const sessionCookie = loginRequest.headers.get('set-cookie');
    if (!sessionCookie) {
        console.error('Failed to get a session cookie for code-based login.');
        return;
    }

    console.log('A one-time code has been sent to your email.');
    return await performCodeVerification(sessionCookie, { env, protocol, verbose });
}

/**
 * Handles the complete authentication flow for the passwordless "Magic Link" method.
 *
 * @param {object} credentials - The user's credentials and environment details.
 * @param {string} credentials.username - The user's username.
 * @param {string} credentials.env - The target environment name.
 * @param {string} credentials.protocol - The protocol ('http' or 'https').
 * @param {boolean} credentials.verbose - A flag for verbose logging.
 * @returns {Promise<string|undefined>} The final authentication token, or undefined on failure.
 */
async function loginWithLink({ username, env, protocol, verbose }) {
    const host = getConfig().env[env].host;
    const baseUrl = `${protocol}://${host}/Admin/Authentication`;
    const loginUrl = `${baseUrl}/Login`;

    const linkRequest = await fetch(loginUrl, {
        method: 'POST',
        body: new URLSearchParams({ Username: username }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        agent: getAgent(protocol)
    });

    if (!linkRequest.ok) {
        console.error(`Login attempt failed with username ${username}, please verify its a valid user in your Dynamicweb solution`);
        if (verbose) {
            console.info(linkRequest);
        }

        return;
    }

    console.log('If a user with that username exists, a magic link has been sent to the associated email.');

    const { secretKey } = await yargsInteractive().interactive({
        interactive: { default: true },
        secretKey: { type: 'input', describe: 'Please find the link in your email and paste the secretKey here:' }
    });

    if (!secretKey) {
        console.error('A secret key from the link is required to proceed.');
        return;
    }

    const verifyRequest = await fetch(`${loginUrl}/Link?secretKey=${encodeURIComponent(secretKey)}`, {
        method: 'GET',
        agent: getAgent(protocol),
        redirect: 'manual'
    });

    if (verifyRequest.status !== 302 && !verifyRequest.ok) {
        console.error('Magic link verification failed. The link may be expired, invalid, or already used.');
        if (verbose) {
            console.info(await verifyRequest.text().catch(() => 'Could not read body.'));
        }

        return;
    }

    const userAuthCookieHeader = verifyRequest.headers.get('set-cookie');
    const { user } = parseCookies(userAuthCookieHeader);
    if (!user) return;

    return await getToken(user, env, protocol, verbose);
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