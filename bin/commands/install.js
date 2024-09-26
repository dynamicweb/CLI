import fetch from 'node-fetch';
import path from 'path';
import { setupEnv, getAgent } from './env.js';
import { setupUser } from './login.js';
import { uploadFiles, resolveFilePath } from './files.js';

export function installCommand() {
    return {
        command: 'install [filePath]', 
        describe: 'Installs the addin on the given path, allowed file extensions are .dll, .nupkg', 
        builder: (yargs) => {
            return yargs
            .positional('filePath', {
                describe: 'Path to the file to install'
            })
        },
        handler: (argv) => {
            if (argv.verbose) console.info(`Installing file located at :${argv.filePath}`)
            handleInstall(argv)
        }
    }
}

async function handleInstall(argv) {
    let env = await setupEnv(argv);
    let user = await setupUser(argv, env);
    await uploadFiles(env, user, [ argv.filePath ], 'System/AddIns/Local', false, true);
    await installAddin(env, user, resolveFilePath(argv.filePath))
}

async function installAddin(env, user, resolvedPath) {
    console.log('Installing addin')
    let filename = path.basename(resolvedPath);
    let data = {
        'Ids': [
            `${filename.substring(0, filename.lastIndexOf('.')) || filename}|${path.extname(resolvedPath)}`
        ]
    }
    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/AddinInstall`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    });

    if (res.ok) {
        if (env.verbose) console.log(await res.json())
        console.log(`Addin installed`)
    }
    else {
        console.log('Request failed, returned error:')
        console.log(await res.json())
        process.exit(1);
    }
}