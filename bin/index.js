#! /usr/bin/env node

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { loginCommand } from './commands/login.js';
import { envCommand } from './commands/env.js';
import { configCommand, setupConfig, getConfig } from './commands/config.js';
import { installCommand } from './commands/install.js';
import { filesCommand } from './commands/files.js';
import { swiftCommand } from './commands/swift.js';
import { databaseCommand } from './commands/database.js';
import { queryCommand } from './commands/query.js';
import { commandCommand } from './commands/command.js';

setupConfig();
showGitBashRelativePathWarning();

yargs(hideBin(process.argv))
    .scriptName('dw')
    .command(baseCommand())
    .command(loginCommand())
    .command(envCommand())
    .command(installCommand())
    .command(configCommand())
    .command(filesCommand())
    .command(swiftCommand())
    .command(databaseCommand())
    .command(queryCommand())
    .command(commandCommand())
    .option('verbose', {
        alias: 'v',
        type: 'boolean',
        description: 'Run with verbose logging'
    })
    .option('protocol', {
        description: 'Set the protocol used with --host (defaults to https)'
    })
    .option('host', {
        description: 'Allows setting the host used, only allowed if an --apiKey or OAuth client credentials are specified'
    })
    .option('apiKey', {
        description: 'Allows setting the apiKey for an environmentless execution of the CLI command'
    })
    .option('auth', {
        choices: ['user', 'oauth'],
        description: 'Overrides the authentication mode for the command'
    })
    .option('clientId', {
        description: 'OAuth client ID used together with --auth oauth'
    })
    .option('clientSecret', {
        description: 'OAuth client secret used together with --auth oauth. WARNING: passing this on the command line can expose the secret via shell history and process listings. Prefer using --clientSecretEnv to reference a secret stored in an environment variable instead.'
    })
    .option('clientIdEnv', {
        description: 'Environment variable name that contains the OAuth client ID'
    })
    .option('clientSecretEnv', {
        description: 'Environment variable name that contains the OAuth client secret'
    })
    .demandCommand()
    .parse()

function baseCommand() {
    return {
        command: '$0',
        describe: 'Shows the current env and user being used',
        handler: () => {
            const cfg = getConfig();
            if (Object.keys(cfg).length === 0) {
                console.log('To login to a solution use `dw login`')
                return;
            }
            const currentEnv = cfg?.env?.[cfg?.current?.env];
            if (!currentEnv) {
                console.log(`Environment '${cfg?.current?.env}' is not configured.`);
                console.log('To login to a solution use `dw login`');
                return;
            }
            const authType = currentEnv?.current?.authType;

            console.log(`Environment: ${cfg?.current?.env}`);
            if (authType === 'oauth_client_credentials') {
                console.log('Authentication: OAuth client credentials');
            } else if (currentEnv?.current?.user) {
                console.log(`User: ${currentEnv.current.user}`);
            }
            if (currentEnv.protocol) {
                console.log(`Protocol: ${currentEnv.protocol}`);
            }
            if (currentEnv.host) {
                console.log(`Host: ${currentEnv.host}`);
            }
        }
    }
}

function showGitBashRelativePathWarning() {
    const isGitBash = !!process.env.MSYSTEM;
    const pathConversionDisabled = process.env.MSYS_NO_PATHCONV === '1';

    if (isGitBash && !pathConversionDisabled) {
        console.warn('You appear to have path conversion turned on in your shell.');
        console.warn('If you are using relative paths, this may interfere.');
        console.warn('Please see https://doc.dynamicweb.dev/documentation/fundamentals/code/CLI.html for more information.');
    }
}
