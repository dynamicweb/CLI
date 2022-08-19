import { exec } from 'child_process';

export function swiftCommand() {
    return {
        command: 'swift [outPath]', 
        describe: 'Downloads latest swift version to outPath', 
        builder: (yargs) => {
            return yargs
            .positional('outPath', {
                describe: 'Location for the swift solution'
            })
            .option('tag', {
                alias: 't',
                description: 'The version tag or branch to clone'
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
    if (argv.verbose) console.info(`Executing command: degit dynamicweb/swift${argv.tag ? '#' + argv.tag : ''} ${argv.force ? '--force' : ''} ${argv.outPath}`)
    exec(`npx degit dynamicweb/swift${argv.tag ? '#' + argv.tag : ''} ${argv.force ? '--force' : ''} ${argv.outPath}`, (error, stdout, stderr) => {
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