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
        description: 'Allows setting the protocol used, only used together with --host, defaulting to https'
    })
    .option('host', {
        description: 'Allows setting the host used, only allowed if an --apiKey is specified'
    })
    .option('apiKey', {
        description: 'Allows setting the apiKey for an environmentless execution of the CLI command'
    })
    .demandCommand()
    .parse()

function baseCommand() {
    return {
        command: '$0',
        describe: 'Shows the current env and user being used',
        handler: () => {
            if (Object.keys(getConfig()).length === 0) {
                console.log('To login to a solution use `dw login`')
                return;
            } 
            console.log(`Environment: ${getConfig()?.current?.env}`)
            console.log(`User: ${getConfig()?.env[getConfig()?.current?.env]?.current?.user}`)
            console.log(`Protocol: ${getConfig()?.env[getConfig()?.current?.env]?.protocol}`)
            console.log(`Host: ${getConfig()?.env[getConfig()?.current?.env]?.host}`)
        }
    }
}