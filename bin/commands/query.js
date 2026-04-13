import fetch from 'node-fetch';
import { setupEnv, getAgent, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { input } from '@inquirer/prompts';

const exclude = ['_', '$0', 'query', 'list', 'i', 'l', 'interactive', 'verbose', 'v', 'host', 'protocol', 'apiKey', 'env', 'output', 'auth', 'clientId', 'clientSecret', 'clientIdEnv', 'clientSecretEnv', 'oauth']

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
                .option('output', {
                    choices: ['json'],
                    describe: 'Outputs a single JSON response for automation-friendly parsing',
                    conflicts: 'interactive'
                })
        },
        handler: async (argv) => {
            const output = createQueryOutput(argv);

            try {
                output.verboseLog(`Running query ${argv.query}`);
                await handleQuery(argv, output);
            } catch (err) {
                output.fail(err);
                if (!output.json) {
                    console.error(err.stack || err.message || String(err));
                }
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

async function handleQuery(argv, output) {
    let env = await setupEnv(argv, output);
    let user = await setupUser(argv, env);
    if (argv.list) {
        const properties = await getProperties(env, user, argv.query);
        output.addData(properties);
        output.log(properties);
    } else {
        let response = await runQuery(env, user, argv.query, await getQueryParams(env, user, argv, output));
        output.addData(response);
        output.log(response);
    }
}

async function getProperties(env, user, query) {
    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/QueryByName?name=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    })
    if (res.ok) {
        let body = await res.json()
        if (body?.model?.properties?.groups === undefined) {
            throw createCommandError('Unable to fetch query parameters.', res.status, body);
        }
        return body.model.properties.groups.filter(g => g.name === 'Properties')[0].fields.map(field => `${field.name} (${field.typeName})`)
    }

    throw createCommandError('Unable to fetch query parameters.', res.status, await parseJsonSafe(res));
}

async function getQueryParams(env, user, argv, output) {
    let params = {}
    if (argv.interactive) {
        let properties = await getProperties(env, user, argv.query);
        output.log('The following properties will be requested:')
        output.log(properties)
        for (const p of properties) {
            const value = await input({ message: p });
            if (value) {
                const fieldName = p.split(' (')[0];
                params[fieldName] = value;
            }
        }
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
        throw createCommandError(`Error when doing request ${res.url}`, res.status, await parseJsonSafe(res));
    }
    return await res.json()
}

function createQueryOutput(argv) {
    const response = {
        ok: true,
        command: 'query',
        operation: argv.list ? 'list' : 'run',
        status: 200,
        data: [],
        errors: [],
        meta: {
            query: argv.query
        }
    };

    return {
        json: argv.output === 'json',
        response,
        log(value) {
            if (!this.json) {
                console.log(value);
            }
        },
        verboseLog(...args) {
            if (argv.verbose && !this.json) {
                console.info(...args);
            }
        },
        addData(entry) {
            response.data.push(entry);
        },
        fail(err) {
            response.ok = false;
            response.status = err?.status || 1;
            response.errors.push({
                message: err?.message || 'Unknown query command error.',
                details: err?.details ?? null
            });
        },
        finish() {
            if (this.json) {
                console.log(JSON.stringify(response, null, 2));
            }
        }
    };
}


async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}
