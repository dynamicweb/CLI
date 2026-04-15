import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import FormData from 'form-data';
import { setupEnv, getAgent, createCommandError } from './env.js';
import { setupUser } from './login.js';
import { interactiveConfirm, formatBytes, createThrottledStatusUpdater } from '../utils.js';
import { downloadWithProgress, tryGetFileNameFromResponse } from '../downloader.js';
import { extractWithProgress } from '../extractor.js';

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
                describe: 'Used with import, will overwrite existing files at destination if set to true'
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
            .option('dangerouslyIncludeLogsAndCache', {
                type: 'boolean',
                describe: 'Includes log and cache folders during export. Risky and usually not recommended'
            })
            .option('iamstupid', {
                type: 'boolean',
                hidden: true,
                describe: 'Deprecated alias for --dangerouslyIncludeLogsAndCache'
            })
            .option('delete', {
                alias: 'd',
                type: 'boolean',
                describe: 'Deletes the file or directory at [dirPath]. Detects type from path (use --asFile/--asDirectory to override)'
            })
            .option('empty', {
                type: 'boolean',
                describe: 'Used with --delete, empties a directory instead of deleting it'
            })
            .option('copy', {
                type: 'string',
                describe: 'Copies the file or directory at [dirPath] to the given destination path'
            })
            .option('move', {
                type: 'string',
                describe: 'Moves the file or directory at [dirPath] to the given destination path'
            })
            .option('asFile', {
                type: 'boolean',
                alias: 'af',
                describe: 'Forces the command to treat the path as a single file, even if it has no extension.',
                conflicts: 'asDirectory'
            })
            .option('asDirectory', {
                type: 'boolean',
                alias: 'ad',
                describe: 'Forces the command to treat the path as a directory, even if its name contains a dot.',
                conflicts: 'asFile'
            })
            .option('output', {
                choices: ['json'],
                describe: 'Outputs a single JSON response for automation-friendly parsing'
            })
            .option('json', {
                type: 'boolean',
                hidden: true,
                describe: 'Deprecated alias for --output json'
            })
        },
        handler: async (argv) => {
            if (argv.json && !argv.output) {
                argv.output = 'json';
                console.warn('Warning: --json is deprecated and will be removed in a future release. Use --output json instead.');
            }
            if (argv.iamstupid && !argv.dangerouslyIncludeLogsAndCache) {
                argv.dangerouslyIncludeLogsAndCache = true;
                console.warn('Warning: --iamstupid is deprecated and will be removed in a future release. Use --dangerouslyIncludeLogsAndCache instead.');
            }
            const output = createFilesOutput(argv);

            try {
                await handleFiles(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

async function handleFiles(argv, output) {
    let env = await setupEnv(argv, output);
    let user = await setupUser(argv, env);

    if (argv.list) {
        output.verboseLog(`Listing directory at: ${argv.dirPath}`);
        let files = (await getFilesStructure(env, user, argv.dirPath, argv.recursive, argv.includeFiles)).model;
        output.setStatus(200);
        output.addData(files);
        if (!output.json) {
            output.log(files.name);
            let hasFiles = files.files?.data && files.files?.data.length !== 0;
            resolveTree(files.directories, '', hasFiles, output);
            resolveTree(files.files?.data ?? [], '', false, output);
        }
    }

    if (argv.export) {
        if (argv.dirPath) {
            
            const isFile = isFilePath(argv, argv.dirPath);

            if (isFile) {
                let parentDirectory = path.dirname(argv.dirPath);              
                parentDirectory = parentDirectory === '.' ? '/' : parentDirectory;
                
                await download(env, user, parentDirectory, argv.outPath, false, null, true, argv.dangerouslyIncludeLogsAndCache, [argv.dirPath], true, output);
            } else {
                await download(env, user, argv.dirPath, argv.outPath, true, null, argv.raw, argv.dangerouslyIncludeLogsAndCache, [], false, output);
            }
        } else {
            const fullExport = async () => {
                output.log('Full export is starting');
                let filesStructure = (await getFilesStructure(env, user, '/', false, true)).model;
                let dirs = filesStructure.directories;
                for (let id = 0; id < dirs.length; id++) {
                    const dir = dirs[id];
                    await download(env, user, dir.name, argv.outPath, true, null, argv.raw, argv.dangerouslyIncludeLogsAndCache, [], false, output);
                }
                await download(env, user, '/.', argv.outPath, false, 'Base.zip', argv.raw, argv.dangerouslyIncludeLogsAndCache, Array.from(filesStructure.files.data, f => f.name), false, output);
                if (argv.raw) output.log('The files in the base "files" folder is in Base.zip, each directory in "files" is in its own zip');
            };

            if (output.json) {
                await fullExport();
            } else {
                await interactiveConfirm('Are you sure you want a full export of files?', fullExport);
            }
        }
    } else if (argv.import) {
        if (argv.dirPath && argv.outPath) {
            let resolvedPath = path.resolve(argv.dirPath);
            if (argv.recursive) {
                await processDirectory(env, user, resolvedPath, argv.outPath, resolvedPath, argv.createEmpty, true, argv.overwrite, output);
            } else {
                let filesInDir = getFilesInDirectory(resolvedPath);
                await uploadFiles(env, user, filesInDir, argv.outPath, argv.createEmpty, argv.overwrite, output);
            }
        }
    } else if (argv.delete) {
        if (!argv.dirPath) {
            throw createCommandError('A path is required for delete operations.', 400);
        }

        const isFile = isFilePath(argv, argv.dirPath);

        if (argv.empty && isFile) {
            throw createCommandError('--empty can only be used with directories.', 400);
        }

        const shouldConfirm = !output.json;

        if (shouldConfirm) {
            const action = argv.empty
                ? `empty directory "${argv.dirPath}"`
                : isFile
                    ? `delete file "${argv.dirPath}"`
                    : `delete directory "${argv.dirPath}"`;

            await interactiveConfirm(`Are you sure you want to ${action}?`, async () => {
                await deleteRemote(env, user, argv.dirPath, isFile, argv.empty, output);
            });
        } else {
            await deleteRemote(env, user, argv.dirPath, isFile, argv.empty, output);
        }
    } else if (argv.copy) {
        if (!argv.dirPath) {
            throw createCommandError('A source path [dirPath] is required for copy operations.', 400);
        }

        await copyRemote(env, user, argv.dirPath, argv.copy, output);
    } else if (argv.move) {
        if (!argv.dirPath) {
            throw createCommandError('A source path [dirPath] is required for move operations.', 400);
        }

        await moveRemote(env, user, argv.dirPath, argv.move, argv.overwrite, output);
    }
}

function getFilesInDirectory(dirPath) {
    return fs.statSync(dirPath).isFile() ? [ dirPath ] : fs.readdirSync(dirPath)
            .map(file => path.join(dirPath, file))
            .filter(file => fs.statSync(file).isFile());
}

async function processDirectory(env, user, dirPath, outPath, originalDir, createEmpty, isRoot = false, overwrite = false, output) {
    let filesInDir = getFilesInDirectory(dirPath);
    if (filesInDir.length > 0)
        await uploadFiles(env, user, filesInDir, isRoot ? outPath : path.join(outPath, path.basename(dirPath)), createEmpty, overwrite, output);

    const subDirectories = fs.readdirSync(dirPath)
                            .map(subDir => path.join(dirPath, subDir))
                            .filter(subDir => fs.statSync(subDir).isDirectory());
    for (let subDir of subDirectories) {
        await processDirectory(env, user, subDir, isRoot ? outPath : path.join(outPath, path.basename(dirPath)), originalDir, createEmpty, false, overwrite, output);
    }
}

function resolveTree(dirs, indentLevel, parentHasFiles, output) {
    let end = `└──`
    let mid = `├──`
    for (let id = 0; id < dirs.length; id++) {
        const dir = dirs[id];
        let indentPipe = true;
        if (dirs.length == 1) {
            if (parentHasFiles) {
                output.log(indentLevel + mid, dir.name)
            } else {
                output.log(indentLevel + end, dir.name)
                indentPipe = false;
            }
        } else if (id != dirs.length - 1) {
            output.log(indentLevel + mid, dir.name)
        } else {
            if (parentHasFiles) {
                output.log(indentLevel + mid, dir.name)
            } else {
                output.log(indentLevel + end, dir.name)
                indentPipe = false;
            }
        }
        let hasFiles = dir.files?.data && dir.files?.data.length !== 0;
        if (indentPipe) {
            resolveTree(dir.directories ?? [], indentLevel + '│\t', hasFiles, output);
            resolveTree(dir.files?.data ?? [], indentLevel + '│\t', false, output);
        } else {
            resolveTree(dir.directories ?? [], indentLevel + '\t', hasFiles, output);
            resolveTree(dir.files?.data ?? [], indentLevel + '\t', false, output);  
        }
    }
}

async function download(env, user, dirPath, outPath, recursive, outname, raw, dangerouslyIncludeLogsAndCache, fileNames, singleFileMode, output) {
    let excludeDirectories = '';
    if (!dangerouslyIncludeLogsAndCache) {
        excludeDirectories = 'system/log';
        if (dirPath === 'cache.net') {
            return;
        }
    }

    const { endpoint, data } = prepareDownloadCommandData(dirPath, excludeDirectories, fileNames, recursive, singleFileMode);

    displayDownloadMessage(dirPath, fileNames, recursive, singleFileMode, output);

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    const filename = outname || tryGetFileNameFromResponse(res, dirPath, output.verbose);
    if (!filename) return;

    const filePath = path.resolve(`${path.resolve(outPath)}/${filename}`)
    const updater = output.json ? null : createThrottledStatusUpdater();

    await downloadWithProgress(res, filePath, {
        onData: (received) => {
            if (updater) {
                updater.update(`Received:\t${formatBytes(received)}`);
            }
        }
    });

    if (updater) {
        updater.stop();
    }

    if (singleFileMode) {
        output.log(`Successfully downloaded: ${filename}`);
    } else {
        output.log(`Finished downloading`, dirPath === '/.' ? '.' : dirPath, 'Recursive=' + recursive);
    }

    output.addData({
        type: 'download',
        directoryPath: dirPath,
        filename,
        outPath: path.resolve(outPath),
        recursive,
        raw
    });

    await extractArchive(filename, filePath, outPath, raw, output);
}

export function prepareDownloadCommandData(directoryPath, excludeDirectories, fileNames, recursive, singleFileMode) {
    const data = {
        'DirectoryPath': directoryPath ?? '/',
        'ExcludeDirectories': [excludeDirectories],
    };

    if (recursive && !singleFileMode) {
        return { endpoint: 'DirectoryDownload', data };
    }

    data['Ids'] = fileNames;
    return { endpoint: 'FileDownload', data };
}

function displayDownloadMessage(directoryPath, fileNames, recursive, singleFileMode, output) {
    if (singleFileMode) {
        const fileName = path.basename(fileNames[0] || 'unknown');
        output.log('Downloading file: ' + fileName);

        return;
    }

    const directoryPathDisplayName = directoryPath === '/.'
        ? 'Base'
        : directoryPath;

    output.log('Downloading', directoryPathDisplayName, 'Recursive=' + recursive);
}

async function extractArchive(filename, filePath, outPath, raw, output) {
    if (raw) {
        return;
    }

    output.log(`\nExtracting ${filename} to ${outPath}`);
    let destinationFilename = filename.replace('.zip', '');
    if (destinationFilename === 'Base')
        destinationFilename = '';

    const destinationPath = `${path.resolve(outPath)}/${destinationFilename}`;
    const updater = output.json ? null : createThrottledStatusUpdater();

    await extractWithProgress(filePath, destinationPath, {
        onEntry: (processedEntries, totalEntries, percent) => {
            if (updater) {
                updater.update(`Extracted:\t${processedEntries} of ${totalEntries} files (${percent}%)`);
            }
        }
    });

    if (updater) {
        updater.stop();
    }
    output.log(`Finished extracting ${filename} to ${outPath}\n`);

    fs.unlink(filePath, function(err) {
        if (err) {
            output.verboseLog(`Warning: Failed to delete temporary archive ${filePath}: ${err.message}`);
        }
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
        throw createCommandError('Unable to fetch file structure.', res.status, await parseJsonSafe(res));
    }
}

async function deleteRemote(env, user, remotePath, isFile, empty, output) {
    let endpoint;
    let mode;
    let data;

    if (isFile) {
        endpoint = 'FileDelete';
        mode = 'file';
        const parentDir = path.posix.dirname(remotePath);
        data = {
            DirectoryPath: parentDir === '.' ? '/' : parentDir,
            Ids: [remotePath]
        };
    } else if (empty) {
        endpoint = 'DirectoryEmpty';
        mode = 'empty';
        data = { Path: remotePath };
    } else {
        endpoint = 'DirectoryDelete';
        mode = 'directory';
        data = { Path: remotePath };
    }

    output.log(`${mode === 'empty' ? 'Emptying' : 'Deleting'} ${mode === 'file' ? 'file' : 'directory'}: ${remotePath}`);

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    if (!res.ok) {
        throw createCommandError(`Failed to ${mode === 'empty' ? 'empty' : 'delete'} "${remotePath}".`, res.status, await parseJsonSafe(res));
    }

    const body = await parseJsonSafe(res);

    output.setStatus(200);
    output.addData({
        type: 'delete',
        path: remotePath,
        mode,
        response: body
    });

    output.log(`Successfully ${mode === 'empty' ? 'emptied' : 'deleted'}: ${remotePath}`);
}

async function copyRemote(env, user, sourcePath, destination, output) {
    output.log(`Copying ${sourcePath} to ${destination}`);

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/AssetCopy`, {
        method: 'POST',
        body: JSON.stringify({
            Destination: destination,
            Ids: [sourcePath]
        }),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    if (!res.ok) {
        throw createCommandError(`Failed to copy "${sourcePath}" to "${destination}".`, res.status, await parseJsonSafe(res));
    }

    const body = await parseJsonSafe(res);

    output.setStatus(200);
    output.addData({
        type: 'copy',
        sourcePath,
        destination,
        response: body
    });

    output.log(`Successfully copied ${sourcePath} to ${destination}`);
}

async function moveRemote(env, user, sourcePath, destination, overwrite, output) {
    output.log(`Moving ${sourcePath} to ${destination}`);

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/AssetMove`, {
        method: 'POST',
        body: JSON.stringify({
            Destination: destination,
            Overwrite: Boolean(overwrite),
            Ids: [sourcePath]
        }),
        headers: {
            'Authorization': `Bearer ${user.apiKey}`,
            'Content-Type': 'application/json'
        },
        agent: getAgent(env.protocol)
    });

    if (!res.ok) {
        throw createCommandError(`Failed to move "${sourcePath}" to "${destination}".`, res.status, await parseJsonSafe(res));
    }

    const body = await parseJsonSafe(res);

    output.setStatus(200);
    output.addData({
        type: 'move',
        sourcePath,
        destination,
        overwrite: Boolean(overwrite),
        response: body
    });

    output.log(`Successfully moved ${sourcePath} to ${destination}`);
}

export async function uploadFiles(env, user, localFilePaths, destinationPath, createEmpty = false, overwrite = false, output = createFilesOutput({})) {
    output.log('Uploading files')

    const chunkSize = 300;
    const chunks = [];

    for (let i = 0; i < localFilePaths.length; i += chunkSize) {
        chunks.push(localFilePaths.slice(i, i + chunkSize));
    }

    output.mergeMeta((meta) => ({
        filesProcessed: (meta.filesProcessed || 0) + localFilePaths.length,
        chunks: (meta.chunks || 0) + chunks.length
    }));

    for (let i = 0; i < chunks.length; i++) {
        output.log(`Uploading chunk ${i + 1} of ${chunks.length}`);

        const chunk = chunks[i];
        const body = await uploadChunk(env, user, chunk, destinationPath, createEmpty, overwrite, output);
        output.addData({
            type: 'upload',
            destinationPath,
            files: chunk.map(filePath => path.resolve(filePath)),
            response: body
        });

        output.log(`Finished uploading chunk ${i + 1} of ${chunks.length}`);
    }

    output.log(`Finished uploading files. Total files: ${localFilePaths.length}, total chunks: ${chunks.length}`);
}

async function uploadChunk(env, user, filePathsChunk, destinationPath, createEmpty, overwrite, output) {
    const form = new FormData();
    form.append('path', destinationPath);
    form.append('skipExistingFiles', String(!overwrite));
    form.append('allowOverwrite', String(overwrite));
    
    filePathsChunk.forEach(fileToUpload => {
        output.log(`${fileToUpload}`)
        form.append('files', fs.createReadStream(path.resolve(fileToUpload)));
    });

    const res = await fetch(`${env.protocol}://${env.host}/Admin/Api/Upload?` + new URLSearchParams({"createEmptyFiles": createEmpty, "createMissingDirectories": true}), {
        method: 'POST',
        body: form,
        headers: {
            'Authorization': `Bearer ${user.apiKey}`
        },
        agent: getAgent(env.protocol)
    });
    
    if (res.ok) {
        return await res.json();
    }
    else {
        throw createCommandError('File upload failed.', res.status, await parseJsonSafe(res));
    }
}

export function resolveFilePath(filePath) {
    let p = path.parse(path.resolve(filePath))
    let regex = wildcardToRegExp(p.base);
    let resolvedPath = fs.readdirSync(p.dir).filter((allFilesPaths) => allFilesPaths.match(regex) !== null)[0]
    if (resolvedPath === undefined)
    {
        throw createCommandError(`Could not find any files with the name ${filePath}`, 1);
    }
    return path.join(p.dir, resolvedPath);
}


export function isFilePath(argv, dirPath) {
    if (argv.asFile || argv.asDirectory) {
        return Boolean(argv.asFile);
    }
    return path.extname(dirPath) !== '';
}

export function wildcardToRegExp(wildcard) {
    const escaped = wildcard.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

function createFilesOutput(argv) {
    const response = {
        ok: true,
        command: 'files',
        operation: getFilesOperation(argv),
        status: 200,
        data: [],
        errors: [],
        meta: {}
    };

    return {
        json: argv.output === 'json' || Boolean(argv.json),
        verbose: Boolean(argv.verbose),
        response,
        log(...args) {
            if (!this.json) {
                console.log(...args);
            }
        },
        verboseLog(...args) {
            if (this.verbose && !this.json) {
                console.info(...args);
            }
        },
        addData(entry) {
            response.data.push(entry);
        },
        mergeMeta(metaOrFn) {
            const meta = typeof metaOrFn === 'function' ? metaOrFn(response.meta) : metaOrFn;
            response.meta = {
                ...response.meta,
                ...meta
            };
        },
        setStatus(status) {
            response.status = status;
        },
        fail(err) {
            response.ok = false;
            response.status = err?.status || 1;
            response.errors.push({
                message: err?.message || 'Unknown files command error.',
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

export function getFilesOperation(argv) {
    if (argv.list) {
        return 'list';
    }

    if (argv.export) {
        return 'export';
    }

    if (argv.import) {
        return 'import';
    }

    if (argv.delete) {
        return 'delete';
    }

    if (argv.copy) {
        return 'copy';
    }

    if (argv.move) {
        return 'move';
    }

    return 'unknown';
}


async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}
