#! /usr/bin/env node

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { loginCommand } from './login.js';
import { envCommand } from './env.js';
import { configCommand, setupConfig, getConfig } from './config.js';
import { installCommand } from './install.js';
import { filesCommand } from './files.js';
import { swiftCommand } from './swift.js';

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
    .option('verbose', {
        alias: 'v',
        type: 'boolean',
        description: 'Run with verbose logging'
    })
    .demandCommand()
    .parse()

function baseCommand() {
    return {
        command: '$0',
        describe: 'Shows the current env and user being used',
        handler: () => {
            console.log(`Environment: ${getConfig()?.current?.env}`)
            console.log(`User: ${getConfig()?.env[getConfig()?.current?.env]?.current?.user}`)
        }
    }
}