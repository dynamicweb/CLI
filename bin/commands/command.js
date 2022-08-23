import { Agent } from 'https';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { setupEnv } from './env.js';
import { setupUser } from './login.js';

const agent = new Agent({
    rejectUnauthorized: false
})

const exclude = ['_', '$0', 'command', 'list', 'json']

export function commandCommand() {
    return {
        command: 'command [command]', 
        describe: 'Runs the given command', 
        builder: (yargs) => {
            return yargs
            .positional('command', {
                describe: 'The command to execute'
            })
            .option('json', {
                describe: 'Literal json or location of json file to send'
            })
            .option('list', {
                alias: 'l',
                describe: 'Lists all the properties for the command, currently not working'
            })
        },
        handler: (argv) => {
            if (argv.verbose) console.info(`Running command ${argv.command}`)
            handleCommand(argv)
        }
    }
}

async function handleCommand(argv) {
    let env = await setupEnv(argv);
    let user = await setupUser(argv, env);
    if (argv.list) {
        console.log(await getProperties(env, user, argv.command))
    } else {
        let response = await runCommand(env, user, argv.command, getQueryParams(argv), getFormParams(argv.json))
        console.log(response)
    }
}

async function getProperties(env, user, command) {
    return `This option currently doesn't work`
    let res = await fetch(`https://${env.host}/Admin/Api/CommandByName?name=${command}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: agent
    })
    if (res.ok) {
        let body = await res.json()
        return body.model.propertyNames
    }
}

function getQueryParams(argv) {
    let params = {}
    Object.keys(argv).filter(k => !exclude.includes(k)).forEach(k => params['Command.' + k] = argv[k])
    return params
}

function getFormParams(json) {
    if (!json) return
    if (fs.existsSync(json)) {
        return JSON.parse(fs.readFileSync(path.resolve(json)))
    } else {
        return JSON.parse(json)
    }
}

async function runCommand(env, user, command, queryParams, formParams) {
    let res = await fetch(`https://${env.host}/Admin/Api/${command}?` + new URLSearchParams(queryParams), {
        method: 'POST',
        body: new URLSearchParams(formParams),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        agent: agent
    })
    if (!res.ok) {
        console.log(`Error when doing request ${res.url}`)
    }
    return await res.json()
}