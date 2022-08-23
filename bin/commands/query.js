import { Agent } from 'https';
import fetch from 'node-fetch';
import { setupEnv } from './env.js';
import { setupUser } from './login.js';

const agent = new Agent({
    rejectUnauthorized: false
})

const exclude = ['_', '$0', 'query', 'list']

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
        console.log(await getProperties(env, user, argv.query))
    } else {
        let response = await runQuery(env, user, argv.query, getQueryParams(argv))
        console.log(response)
    }
}

async function getProperties(env, user, query) {
    let res = await fetch(`https://${env.host}/Admin/Api/QueryByName?name=${query}`, {
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
    Object.keys(argv).filter(k => !exclude.includes(k)).forEach(k => params[k] = argv[k])
    return params
}

async function runQuery(env, user, query, params) {
    let res = await fetch(`https://${env.host}/Admin/Api/${query}?` + new URLSearchParams(params), {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: agent
    })
    if (!res.ok) {
        console.log(`Error when doing request ${res.url}`)
    }
    return await res.json()
}