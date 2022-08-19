import fetch from 'node-fetch';
import fs from 'fs';
import _path from 'path';
import { Agent } from 'https';
import { setupEnv } from './env.js';
import { setupUser } from './login.js';

const agent = new Agent({
    rejectUnauthorized: false
})

export function databaseCommand() {
    return {
        command: 'database [path]', 
        describe: 'Handles database', 
        builder: (yargs) => {
            return yargs
            .positional('path', {
                describe: 'Path to the .bacpac file',
                default: '.'
            })
            .option('export', {
                alias: 'e',
                type: 'boolean',
                description: 'Exports the solutions database to a .bacpac file at [path]'
            })
        },
        handler: (argv) => {
            if (argv.verbose) console.info(`Handling database with path: ${argv.path}`)
            handleDatabase(argv)
        }
    }
}

async function handleDatabase(argv) {
    let env = await setupEnv(argv);
    let user = await setupUser(argv, env);

    if (argv.export) {
        await download(env, user, argv.path, argv.verbose);
    }
}

async function download(env, user, path, verbose) {
    let filename = 'database.bacpac';
    fetch(`https://${env.host}/Admin/Api/DatabaseDownload`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: agent
    }).then(async (res) => {
        if (verbose) console.log(res)
        const header = res.headers.get('Content-Disposition');
        const parts = header?.split(';');
        if (!parts || !header.includes('attachment')) {
            console.log('Failed download, check users database permissions')
            if (verbose) console.log(await res.json())
            return;
        }
        filename = parts[1].split('=')[1];
        return res;
    }).then(async (res) => {
        if (!res) {
            return;
        }
        const fileStream = fs.createWriteStream(_path.resolve(`${_path.resolve(path)}/${filename}`));
        await new Promise((resolve, reject) => {
            res.body.pipe(fileStream);
            res.body.on("error", reject);
            fileStream.on("finish", resolve);
        });
        console.log(`Finished downloading`);
        return res;
    });
}