import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import fetch from 'node-fetch';
import { createCommandError } from './env.js';
import { createOutput } from '../output.js';

const execFileAsync = promisify(execFile);

export function swiftCommand() {
    return {
        command: 'swift [outPath]', 
        describe: 'Downloads latest swift version to outPath', 
        builder: (yargs) => {
            return yargs
            .positional('outPath', {
                default: '.',
                describe: 'Location for the swift solution'
            })
            .option('tag', {
                alias: 't',
                describe: 'The version tag or branch to clone'
            })
            .option('list', {
                alias: 'l',
                describe: 'Lists all release versions'
            })
            .option('nightly', {
                alias: 'n',
                describe: 'Will pull #HEAD, as default is latest release'
            })
            .option('force', {
                type: 'boolean',
                describe: 'Overwrites the contents of [outPath] if it is not empty'
            })
            .option('output', {
                choices: ['json'],
                describe: 'Outputs a single JSON response for automation-friendly parsing'
            })
        },
        handler: async (argv) => {
            const output = createOutput({ command: 'swift', operation: argv.list ? 'list' : 'download', argv });

            try {
                await handleSwift(argv, output);
            } catch (err) {
                output.fail(err);
                process.exitCode = 1;
            } finally {
                output.finish();
            }
        }
    }
}

async function handleSwift(argv, output) {
    if (argv.list) {
        const versions = await getVersions(false);
        output.addData({ versions });
        output.log(versions);
    } else {
        const tag = argv.nightly ? null : argv.tag || await getVersions(true);
        const repo = tag ? `dynamicweb/swift#${tag}` : 'dynamicweb/swift';
        const outPath = path.resolve(argv.outPath);
        const args = ['-y', 'degit', repo];
        if (argv.force) args.push('--force');
        args.push(outPath);
        output.log(`Downloading ${repo} to ${outPath}`);
        output.verboseLog(`Executing: npx ${args.join(' ')}`);
        const [command, commandArgs, options] = resolveNpx(args);
        const plain = (text) => text?.replace(/\x1b\[[0-9;]*m/g, '').trim();
        let result;
        try {
            result = await execFileAsync(command, commandArgs, options);
        } catch (err) {
            // degit reports failures on stderr and exits non-zero.
            throw createCommandError(`Downloading ${repo} failed: ${plain(err.stderr) || err.message}`, 1, plain(err.stdout) || null);
        }
        // degit reports progress on stderr even when it succeeds.
        const progress = [result.stdout, result.stderr].map(plain).filter(Boolean).join('\n');
        if (progress) output.log(progress);
        output.addData({ type: 'download', repo, tag, nightly: Boolean(argv.nightly), outPath });
    }
}

// On Windows npx exists only as a shell script and as npx.cmd, and neither can be
// spawned directly any more: Node removed the implicit shell for .cmd files in the
// CVE-2024-27980 fix (18.20.2 / 20.12.2 / 21.7.3), so execFile('npx') fails with
// ENOENT and execFile('npx.cmd') with EINVAL. Prefer running npm's npx-cli.js with
// the node binary already executing this process, which needs no shell at all and
// so does not expose the arguments to shell parsing. Fall back to a shell only when
// npm is not installed alongside node, as with some version managers.
function resolveNpx(args) {
    const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (fs.existsSync(npxCli)) {
        return [process.execPath, [npxCli, ...args], {}];
    }
    return ['npx', args, { shell: process.platform === 'win32' }];
}

async function getVersions(latest) {
    let res = await fetch(`https://api.github.com/repos/dynamicweb/swift/releases${latest ? '/latest' : ''}`, {
        method: 'GET'
    });
    if (!res.ok) {
        throw createCommandError('Unable to fetch Swift releases from GitHub.', res.status);
    }
    let body = await res.json()
    if (latest) {
        return body.tag_name
    } else {
        return body.map(a => a.tag_name)
    }
}