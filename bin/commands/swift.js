import { execFile } from 'child_process';
import { Agent } from 'https';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const agent = new Agent({
    rejectUnauthorized: false
})

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
            .option('force', {})
        },
        handler: async (argv) => {
            if (argv.verbose) console.info(`Downloading latest swift to :${argv.outPath}`)
            await handleSwift(argv)
        }
    }
}

async function handleSwift(argv) {
    if (argv.list) {
        console.log(await getVersions(false))
    } else {
        const repo = argv.nightly
            ? 'dynamicweb/swift'
            : `dynamicweb/swift#${argv.tag ? argv.tag : await getVersions(true)}`;
        const args = ['degit', repo];
        if (argv.force) args.push('--force');
        args.push(path.resolve(argv.outPath));
        if (argv.verbose) console.info(`Executing: npx ${args.join(' ')}`)
        const [command, commandArgs, options] = resolveNpx(args);
        execFile(command, commandArgs, options, (error, stdout, stderr) => {
            if (error) {
                console.log(`error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.log(stderr);
                return;
            }
            console.log(stdout);
        });
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
        method: 'GET',
        agent: agent
    });
    if (res.ok) {
        let body = await res.json()
        if (latest) {
            return body.tag_name
        } else {
            return body.map(a => a.tag_name)
        }
    }
}