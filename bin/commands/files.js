import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import extract from 'extract-zip';
import FormData from 'form-data';
import { setupEnv, getAgent } from './env.js';
import { setupUser } from './login.js';
import { interactiveConfirm } from '../utils.js';

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
                describe: 'Exports the specified directory and all subdirectories at [dirPath] to [outPath]'
            })
            .option('import', {
                alias: 'i',
                type: 'boolean',
                describe: 'Imports the file at [dirPath] to [outPath]'
            })
            .option('overwrite', {
                alias: 'o',
                type: 'boolean',
                describe: 'Used with import, will overwrite existing files at destrination if set to true'
            })
            .option('createEmpty', {
                type: 'boolean',
                describe: 'Used with import, will create a file even if its empty'
            })
            .option('includeFiles', {
                alias: 'f',
                type: 'boolean',
                describe: 'Used with export, includes files in list of directories and files'
            })
            .option('recursive', {
                alias: 'r',
                type: 'boolean',
                describe: 'Used with list, import and export, handles all directories recursively'
            })
            .option('raw', {
                type: 'boolean',
                describe: 'Used with export, keeps zip file instead of unpacking it'
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
            await download(env, user, argv.dirPath, argv.outPath, true, null, argv.raw, argv.iamstupid, []);
        } else {
            await interactiveConfirm('Are you sure you want a full export of files?', async () => {
                console.log('Full export is starting')
                let filesStructure = (await getFilesStructure(env, user, '/', false, true)).model;
                let dirs = filesStructure.directories;
                for (let id = 0; id < dirs.length; id++) {
                    const dir = dirs[id];
                    await download(env, user, dir.name, argv.outPath, true, null, argv.raw, argv.iamstupid, []);
                }
                await download(env, user, '/.', argv.outPath, false, 'Base.zip', argv.raw, argv.iamstupid, Array.from(filesStructure.files.data, f => f.name));
                if (argv.raw) console.log('The files in the base "files" folder is in Base.zip, each directory in "files" is in its own zip')
            })
        }
    } else if (argv.import) {
        if (argv.dirPath && argv.outPath) {
            let resolvedPath = path.resolve(argv.dirPath);
            if (argv.recursive) {
                await processDirectory(env, user, resolvedPath, argv.outPath, resolvedPath, argv.createEmpty, true, argv.overwrite);
            } else {
                let filesInDir = getFilesInDirectory(resolvedPath);
                await uploadFiles(env, user, filesInDir, argv.outPath, argv.createEmpty, argv.overwrite);
            }
        }
    }
}

function getFilesInDirectory(dirPath) {
    return fs.statSync(dirPath).isFile() ? [ dirPath ] : fs.readdirSync(dirPath)
            .map(file => path.join(dirPath, file))
            .filter(file => fs.statSync(file).isFile());
}

async function processDirectory(env, user, dirPath, outPath, originalDir, createEmpty, isRoot = false, overwrite = false) {
    let filesInDir = getFilesInDirectory(dirPath);
    if (filesInDir.length > 0)
        await uploadFiles(env, user, filesInDir, isRoot ? outPath : path.join(outPath, path.basename(dirPath)), createEmpty, overwrite);

    const subDirectories = fs.readdirSync(dirPath)
                            .map(subDir => path.join(dirPath, subDir))
                            .filter(subDir => fs.statSync(subDir).isDirectory());
    for (let subDir of subDirectories) {
        await processDirectory(env, user, subDir, isRoot ? outPath : path.join(outPath, path.basename(dirPath)), originalDir, createEmpty, false, overwrite);
    }
}

function resolveTree(dirs, indentLevel, parentHasFiles) {
    let end = `└──`
    let mid = `├──`
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
            resolveTree(dir.directories ?? [], indentLevel + '│\t', hasFiles);
            resolveTree(dir.files?.data ?? [], indentLevel + '│\t', false);
        } else {
            resolveTree(dir.directories ?? [], indentLevel + '\t', hasFiles);
            resolveTree(dir.files?.data ?? [], indentLevel + '\t', false);  
        }
    }
}

async function download(env, user, dirPath, outPath, recursive, outname, raw, iamstupid, fileNames) {
    let endpoint;
    let excludeDirectories = '';
    if (!iamstupid) {
        excludeDirectories = 'system/log';
        if (dirPath === 'cache.net') {
            return;
        }
    }
    let data = {
        'DirectoryPath': dirPath ?? '/',
        'ExcludeDirectories': [ excludeDirectories ],
    }

    if (recursive) {
        endpoint = 'DirectoryDownload';
    } else {
        endpoint = 'FileDownload'
        data['Ids'] = fileNames
    }

    console.log('Downloading', dirPath === '/.' ? 'Base' : dirPath, 'Recursive=' + recursive);

    let filename;
    fetch(`${env.protocol}://${env.host}/Admin/Api/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
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
        console.log(`Finished downloading`, dirPath === '/.' ? '.' : dirPath, 'Recursive=' + recursive);
        if (!raw) {
            let filenameWithoutExtension = filename.replace('.zip', '')
            await extract(filePath, { dir: `${path.resolve(outPath)}/${filenameWithoutExtension === 'Base' ? '' : filenameWithoutExtension}` }, function (err) {})
            fs.unlink(filePath, function(err) {})
        }
        return res;
    });
}

async function getFilesStructure(env, user, dirPath, recursive, includeFiles) {
    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/DirectoryAll?DirectoryPath=${dirPath ?? '/'}&recursive=${recursive ?? 'false'}&includeFiles=${includeFiles ?? 'false'}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    });
    if (res.ok) {
        return await res.json();
    } else {
        console.log(res);
        console.log(res.json());
        process.exit(1);
    }
}

export async function uploadFiles(env, user, localFilePaths, destinationPath, createEmpty = false, overwrite = false) {
    console.log('Uploading files')
    let form = new FormData();
    form.append('path', destinationPath);
    form.append('skipExistingFiles', String(!overwrite));
    form.append('allowOverwrite', String(overwrite));
    localFilePaths.forEach((localPath, index) => {
        let fileToUpload = resolveFilePath(localPath)
        console.log(fileToUpload)
        if (fileToUpload === undefined)
            return;
        form.append('files', fs.createReadStream(path.resolve(fileToUpload)));
    });
    let res = await fetch(`${env.protocol}://${env.host}/Admin/Api/Upload?` + new URLSearchParams({"createEmptyFiles": createEmpty, "createMissingDirectories": true}), {
        method: 'POST',
        body: form,
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    });
    if (res.ok) {
        console.log(await res.json())
        console.log(`Files uploaded`)
    }
    else {
        console.log(res)
        console.log(res.json())
        process.exit(1);
    }
}

export function resolveFilePath(filePath) {
    let p = path.parse(path.resolve(filePath))
    let regex = wildcardToRegExp(p.base);
    let resolvedPath = fs.readdirSync(p.dir).filter((allFilesPaths) => allFilesPaths.match(regex) !== null)[0]
    if (resolvedPath === undefined)
    {
        console.log('Could not find any files with the name ' + filePath);
        process.exit(1);
    }
    return path.join(p.dir, resolvedPath);
}

function wildcardToRegExp(wildcard) {
    return new RegExp('^' + wildcard
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      + '$');
}
