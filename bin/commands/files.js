import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import extract from 'extract-zip';
import FormData from 'form-data';
import { Agent } from 'https';
import { setupEnv } from './env.js';
import { setupUser } from './login.js';
import { interactiveConfirm } from '../utils.js';

const agent = new Agent({
    rejectUnauthorized: false
})

export function filesCommand() {
    return {
        command: 'files [dirPath] [outPath]', 
        describe: 'Handles files', 
        builder: (yargs) => {
            return yargs
            .positional('dirPath', {
                describe: 'The directory to list or export'
            })
            .positional('outPath', {
                describe: 'The directory to export the specified directory to',
                default: '.'
            })
            .option('list', {
                alias: 'l',
                type: 'boolean',
                describe: 'Lists all directories and files'
            })
            .option('export', {
                alias: 'e',
                type: 'boolean',
                describe: 'Exports the directory at [dirPath] to [outPath]'
            })
            .option('import', {
                alias: 'i',
                type: 'boolean',
                describe: 'Imports the file at [dirPath] to [outPath]'
            })
            .option('includeFiles', {
                alias: 'f',
                type: 'boolean',
                describe: 'Includes files in list of directories and files'
            })
            .option('recursive', {
                alias: 'r',
                type: 'boolean',
                describe: 'Handles all directories recursively'
            })
            .option('raw', {
                type: 'boolean',
                describe: 'Keeps zip file instead of unpacking it'
            })
            .option('iamstupid', {
                type: 'boolean',
                describe: 'Includes export of log and cache folders, NOT RECOMMENDED'
            })
        },
        handler: (argv) => {
            if (argv.verbose) console.info(`Listing directory at: ${argv.dirPath}`)
            handleFiles(argv)
        }
    }
}

async function handleFiles(argv) {
    let env = await setupEnv(argv);
    let user = await setupUser(argv, env);

    if (argv.list) {
        let files = (await getFilesStructure(env, user, argv.dirPath, argv.recursive, argv.includeFiles)).model;
        console.log(files.name)
        let hasFiles = files.files?.data && files.files?.data.length !== 0;
        resolveTree(files.directories, '', hasFiles);
        resolveTree(files.files?.data ?? [], '', false);
    }

    if (argv.export) {
        if (argv.dirPath) {
            await download(env, user, argv.dirPath, argv.outPath, argv.recursive);
        } else {
            await interactiveConfirm('Are you sure you want a full export of files?', async () => {
                console.log('Full export is starting')
                let dirs = (await getFilesStructure(env, user, '', false, false)).model.directories;
                for (let id = 0; id < dirs.length; id++) {
                    const dir = dirs[id];
                    await download(env, user, dir.name, argv.outPath, true, null, argv.iamstupid);
                }
                await download(env, user, '', argv.outPath, false, 'Base.zip', argv.iamstupid);
                console.log('The files in the base "files" folder is in Base.zip, each directory in "files" is in its own zip')
            })
        }
    } else if (argv.import) {
        if (argv.dirPath && argv.outPath) {
            await uploadFile(env, user, argv.dirPath, argv.outPath);
        }
    }
}

function resolveTree(dirs, indentLevel, parentHasFiles) {
    let end = `?????????`
    let mid = `?????????`
    for (let id = 0; id < dirs.length; id++) {
        const dir = dirs[id];
        let indentPipe = true;
        if (dirs.length == 1) {
            if (parentHasFiles) {
                console.log(indentLevel + mid, dir.name)
            } else {
                console.log(indentLevel + end, dir.name)
                indentPipe = false;
            }
        } else if (id != dirs.length - 1) {
            console.log(indentLevel + mid, dir.name)
        } else {
            if (parentHasFiles) {
                console.log(indentLevel + mid, dir.name)
            } else {
                console.log(indentLevel + end, dir.name)
                indentPipe = false;
            }
        }
        let hasFiles = dir.files?.data && dir.files?.data.length !== 0;
        if (indentPipe) {
            resolveTree(dir.directories ?? [], indentLevel + '???\t', hasFiles);
            resolveTree(dir.files?.data ?? [], indentLevel + '???\t', false);
        } else {
            resolveTree(dir.directories ?? [], indentLevel + '\t', hasFiles);
            resolveTree(dir.files?.data ?? [], indentLevel + '\t', false);  
        }
    }
}

async function download(env, user, dirPath, outPath, recursive, outname, iamstupid) {
    let endpoint;
    if (recursive) {
        endpoint = 'DirectoryDownload';
    } else {
        endpoint = 'FileDownload'
    }
    let excludeDirectories = '';
    if (!iamstupid) {
        excludeDirectories = 'system/log';
        if (dirPath === 'cache.net') {
            return;
        }
    }

    console.log('Downloading', dirPath === '' ? 'Base' : dirPath, 'Recursive=' + recursive);

    let filename;
    let data = {
        'DirectoryPath': dirPath ?? '',
        'ExcludeDirectories': [ excludeDirectories ],
    }
    fetch(`https://${env.host}/Admin/Api/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: agent
    }).then((res) => {
        const header = res.headers.get('content-disposition');
        const parts = header?.split(';');
        if (!parts) {
            console.log(`No files found in directory '${dirPath}', if you want to download all folders recursively include the -r flag`);
            return;
        }
        filename = parts[1].split('=')[1].replace('+', ' ');
        if (outname) filename = outname;
        return res;
    }).then(async (res) => {
        if (!filename) return;
        let filePath = path.resolve(`${path.resolve(outPath)}/${filename}`)
        const fileStream = fs.createWriteStream(filePath);
        await new Promise((resolve, reject) => {
            res.body.pipe(fileStream);
            res.body.on("error", reject);
            fileStream.on("finish", resolve);
        });
        console.log(`Finished downloading`, dirPath === '' ? '.' : dirPath, 'Recursive=' + recursive);
        let filenameWithoutExtension = filename.replace('.zip', '')
        await extract(filePath, { dir: `${path.resolve(outPath)}/${filenameWithoutExtension === 'Base' ? '' : filenameWithoutExtension}` }, function (err) {})
        fs.unlink(filePath, function(err) {})
        return res;
    });
}

async function getFilesStructure(env, user, dirPath, recursive, includeFiles) {
    let res = await fetch(`https://${env.host}/Admin/Api/DirectoryAll?DirectoryPath=${dirPath ?? ''}&recursive=${recursive ?? 'false'}&includeFiles=${includeFiles ?? 'false'}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: agent
    });
    if (res.ok) {
        return await res.json();
    } else {
        console.log(res);
    }
}

export async function uploadFile(env, user, localFilePath, destinationPath) {
    console.log('Uploading file')
    let files = new FormData();
    files.append('files', fs.createReadStream(localFilePath));
    let res = await fetch(`https://${env.host}/Admin/Api/FileUpload?Command.Path=${destinationPath}`, {
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