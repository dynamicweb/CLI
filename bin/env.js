import { updateConfig, getConfig } from './config.js'
import yargsInteractive from 'yargs-interactive';

export function envCommand() {
    return {
        command: 'env [env]',
        describe: 'If environment is specified, changes the current environment to the environment specified, otherwise sets up the config for a new environment',
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
        },
        handler: (argv) => handleEnv(argv)
    }
}

export async function setupEnv(argv) {
    let env;
    if (getConfig().env) {
        env = getConfig().env[argv.env] || getConfig().env[getConfig()?.current?.env];
    }
    if (!env) {
        console.log('Current environment not set, please set it')
        await interactiveEnv(argv, {
            environment: {
                type: 'input'
            },
            interactive: {
                default: true
            }
        })
        env = getConfig().env[getConfig()?.current?.env];
    }
    return env;
}

async function handleEnv(argv) {
    if (argv.users) {
        let env = argv.env || getConfig().current.env;
        console.log(`Users in environment ${env}: ${Object.keys(getConfig().env[env].users || {})}`);
    } else if (argv.env) {
        changeEnv(argv)
    } else if (argv.list) {
        console.log(`Existing environments: ${Object.keys(getConfig().env || {})}`)
    } else {
        interactiveEnv(argv, {
            environment: {
                type: 'input'
            },
            host: {
                type: 'input'
            },
            interactive: {
                default: true
            }
        })
    }
}

export async function interactiveEnv(argv, options) {
    if (argv.verbose) console.info('Setting up new environment')
    await yargsInteractive()
        .interactive(options)
        .then(async (result) => {
            getConfig().env = getConfig().env || {};
            getConfig().env[result.environment] = getConfig().env[result.environment] || {};
            if (result.host)
                getConfig().env[result.environment].host = result.host;
            if (result.environment) {
                getConfig().current = getConfig().current || {};
                getConfig().current.env = result.environment;
            }
            updateConfig();
            console.log(`Your current environment is now ${getConfig().current.env}`);
        });
}

async function changeEnv(argv) {
    if (!Object.keys(getConfig().env).includes(argv.env)) {
        console.log(`The specified environment ${argv.env} doesn't exist, please create it`);
        await interactiveEnv(argv, {
            environment: {
                type: 'input',
                default: argv.env,
                prompt: 'never'
            },
            host: {
                type: 'input',
                prompt: 'always'
            },
            interactive: {
                default: true
            }
        })
    } else {
        getConfig().current.env = argv.env;
        updateConfig();
        console.log(`Your current environment is now ${getConfig().current.env}`);
    }
}

async function changeUser(argv) {
    getConfig().env[getConfig().current.env].current.user = argv.user;
    updateConfig();
    console.log(`You're now logged in as ${getConfig().env[getConfig().current.env].current.user}`);
}