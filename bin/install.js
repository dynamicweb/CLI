import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import FormData from 'form-data';
import { Agent } from 'https';
import { setupEnv } from './env.js';
import { setupUser } from './login.js';

const agent = new Agent({
    rejectUnauthorized: false
})

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
    let resolvedPath = path.resolve(argv.filePath)
    await uploadFile(env, user, resolvedPath);
    await installAddin(env, user, resolvedPath)
}

async function uploadFile(env, user, resolvedPath) {
    console.log('Uploading file')
    let files = new FormData();
    files.append('files', fs.createReadStream(resolvedPath));
    let res = await fetch(`https://${env.host}/Admin/Api/FileUpload?Command.Path=System/AddIns/Local`, {
        method: 'POST',
        body: files,
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: agent
    });
    if (res.ok) {
        if (env.verbose) console.log(await res.json())
        console.log(`File uploaded`)
    }
    else {
        console.log(res)
        return;
    }
}

async function installAddin(env, user, resolvedPath) {
    console.log('Installing addin')
    let data = new URLSearchParams();
    data.append('AddinProvider', 'Dynamicweb.Marketplace.NuGet.LocalAddinProvider');
    data.append('Package', path.basename(resolvedPath));
    let res = await fetch(`https://${env.host}/Admin/Api/AddinInstall`, {
        method: 'POST',
        body: data,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: agent
    });

    if (res.ok) {
        if (env.verbose) console.log(await res.json())
        console.log(`Addin installed`)
    }
    else {
        console.log(res)
    }
}