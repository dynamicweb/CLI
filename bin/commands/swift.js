import { exec } from 'child_process';
import { Agent } from 'https';
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
        handler: (argv) => {
            if (argv.verbose) console.info(`Downloading latest swift to :${argv.outPath}`)
            handleSwift(argv)
        }
    }
}

async function handleSwift(argv) {
    if (argv.list) {
        console.log(await getVersions(false))
    } else {
        let degitCommand
        if (argv.nightly) {
            degitCommand = `npx degit dynamicweb/swift ${argv.force ? '--force' : ''} ${argv.outPath}`
        } else {
            degitCommand = `npx degit dynamicweb/swift#${argv.tag ? argv.tag : await getVersions(true)} ${argv.force ? '--force' : ''} ${argv.outPath}`
        }
        if (argv.verbose) console.info(`Executing command: ${degitCommand}`)
        exec(`${degitCommand}`, (error, stdout, stderr) => {
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