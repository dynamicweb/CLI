import fetch from 'node-fetch';
import { setupEnv, getAgent } from './env.js';
import { setupUser } from './login.js';
import yargsInteractive from 'yargs-interactive';

const exclude = ['_', '$0', 'query', 'list', 'i', 'l', 'interactive']

export function queryCommand() {
    return {
        command: 'query [query]', 
        describe: 'Runs the given query', 
        builder: (yargs) => {
            return yargs
            .positional('query', {
                describe: 'The query to execute'
            })
            .option('list', {
                alias: 'l',
                describe: 'Lists all the properties for the query'
            })
            .option('interactive', {
                alias: 'i',
                describe: 'Runs in interactive mode to ask for query parameters one by one'
            })
        },
        handler: (argv) => {
            if (argv.verbose) console.info(`Running query ${argv.query}`)
            handleQuery(argv)
        }
    }
}

async function handleQuery(argv) {
    let env = await setupEnv(argv);
    let user = await setupUser(argv, env);
    if (argv.list) {
        console.log(await getProperties(argv))
    } else {
        let response = await runQuery(env, user, argv.query, await getQueryParams(argv))
        console.log(response)
    }
}

async function getProperties(argv) {
    let env = await setupEnv(argv);
    let user = await setupUser(argv, env);

    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/QueryByName?name=${argv.query}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    })
    if (res.ok) {
        let body = await res.json()
        return body.model.propertyNames
    }
    console.log(res)
}

async function getQueryParams(argv) {
    let params = {}
    if (argv.interactive) {
        let props = { interactive: { default: true }}
        Array.from(await getProperties(argv)).forEach(p => props[p] = { type: 'input', prompt: 'if-no-arg'})
        await yargsInteractive()
        .interactive(props)
        .then((result) => {
            Object.keys(result).filter(k => !exclude.includes(k)).forEach(k => {
                if (result[k]) params[k] = result[k]
            })
        });
    } else {
        Object.keys(argv).filter(k => !exclude.includes(k)).forEach(k => params[k] = argv[k])
    }
    return params
}

async function runQuery(env, user, query, params) {
    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/${query}?` + new URLSearchParams(params), {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    })
    if (!res.ok) {
        console.log(`Error when doing request ${res.url}`)
        process.exit(1);
    }
    return await res.json()
}