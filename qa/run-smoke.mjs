#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultProfilePath = path.join(__dirname, 'profile.json');
const exampleProfilePath = path.join(__dirname, 'profile.example.json');

const defaultConfig = {
    environmentName: 'qa-smoke',
    clientIdEnv: 'DW_CLIENT_ID',
    clientSecretEnv: 'DW_CLIENT_SECRET',
    remoteRoot: 'QA/CLI',
    commandTimeoutMs: 120000,
    queries: [],
    commands: [],
    install: {
        enabled: false,
        filePath: '',
        queue: true
    }
};

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    printHelp();
    process.exit(0);
}

const runId = createRunId();
const artifactsDir = path.join(__dirname, 'artifacts', runId);
const logsDir = path.join(artifactsDir, 'logs');
const workspaceDir = path.join(artifactsDir, 'workspace');
const homeDir = path.join(artifactsDir, 'home');
const reportPath = path.join(artifactsDir, 'report.json');

fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

const profile = loadProfile(args.profile);
const config = buildConfig(profile, args);
const cleanupTargets = [];

const report = {
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    mode: config.mode,
    artifactsDir,
    config: {
        baseUrl: config.baseUrl,
        protocol: config.protocol,
        host: config.host,
        environmentName: config.environmentName,
        clientIdEnv: config.clientIdEnv,
        clientSecretEnv: config.clientSecretEnv,
        remoteRoot: config.remoteRoot,
        commandTimeoutMs: config.commandTimeoutMs,
        profilePath: config.profilePath
    },
    steps: []
};

const sharedEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEPATH: homeDir,
    [config.clientIdEnv]: process.env[config.clientIdEnv],
    [config.clientSecretEnv]: process.env[config.clientSecretEnv]
};

main().catch(async (error) => {
    report.status = 'failed';
    report.error = {
        message: error.message,
        stack: error.stack
    };
    report.finishedAt = new Date().toISOString();
    flushReport();
    await cleanupRemoteTargets(true);
    console.error(`QA smoke run failed: ${error.message}`);
    console.error(`Report: ${reportPath}`);
    process.exitCode = 1;
});

async function main() {
    console.log(`QA smoke run ${runId}`);
    console.log(`Artifacts: ${artifactsDir}`);

    await runStep('validate configuration', async () => {
        assert(process.env[config.clientIdEnv], `Missing ${config.clientIdEnv} in the environment.`);
        assert(process.env[config.clientSecretEnv], `Missing ${config.clientSecretEnv} in the environment.`);

        return {
            baseUrl: config.baseUrl,
            host: config.host,
            protocol: config.protocol,
            environmentName: config.environmentName,
            remoteRoot: config.remoteRoot
        };
    });

    const localSourceDir = await runStep('prepare local fixtures', async () => {
        const destination = path.join(workspaceDir, 'local-source');
        const templateDir = path.join(__dirname, 'fixtures', 'files', 'source');
        fs.cpSync(templateDir, destination, { recursive: true });
        fs.appendFileSync(
            path.join(destination, 'smoke-upload.txt'),
            `\nRunId=${runId}\nGeneratedAt=${new Date().toISOString()}\n`
        );

        return {
            localSourceDir: destination,
            files: listFilesRecursively(destination).map(file => path.relative(destination, file))
        };
    });

    if (config.mode === 'all' || config.mode === 'saved-env') {
        await runSavedEnvironmentFlow(localSourceDir.localSourceDir);
    } else {
        skipStep('saved environment flow', 'Skipped because --mode is not saved-env or all.');
    }

    if (config.mode === 'all' || config.mode === 'ephemeral') {
        await runEphemeralFlow(localSourceDir.localSourceDir);
    } else {
        skipStep('ephemeral flow', 'Skipped because --mode is not ephemeral or all.');
    }

    await cleanupRemoteTargets(false);

    report.status = 'passed';
    report.finishedAt = new Date().toISOString();
    flushReport();

    console.log('QA smoke run passed.');
    console.log(`Report: ${reportPath}`);
}

async function runSavedEnvironmentFlow(localSourceDir) {
    console.log('Running saved-environment flow...');

    await runStep('saved-env: seed config', async () => {
        await runCliText('saved-env-config', [
            'config',
            `--env.${config.environmentName}.host`, config.host,
            `--env.${config.environmentName}.protocol`, config.protocol,
            '--current.env', config.environmentName
        ]);

        const configPath = path.join(homeDir, '.dwc');
        const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        assert(persisted?.env?.[config.environmentName]?.host === config.host, 'Host was not persisted to the isolated config.');
        assert(persisted?.env?.[config.environmentName]?.protocol === config.protocol, 'Protocol was not persisted to the isolated config.');
        assert(persisted?.current?.env === config.environmentName, 'Current environment was not persisted to the isolated config.');

        return {
            configPath,
            environmentName: config.environmentName
        };
    });

    await runStep('saved-env: list environments', async () => {
        const response = await runCliJson('saved-env-env-list', ['env', '--list', '--output', 'json']);
        assertEnvelope(response, 'env', 'list');

        return response.data[0];
    });

    await runStep('saved-env: select environment', async () => {
        const response = await runCliJson('saved-env-env-select', ['env', config.environmentName, '--output', 'json']);
        assertEnvelope(response, 'env', 'select');

        return response.data[0];
    });

    await runStep('saved-env: oauth login', async () => {
        const response = await runCliJson('saved-env-login', [
            'login',
            '--oauth',
            '--clientIdEnv', config.clientIdEnv,
            '--clientSecretEnv', config.clientSecretEnv,
            '--output', 'json'
        ]);

        assertEnvelope(response, 'login', 'oauth-login');

        return response.data[0];
    });

    await runStep('saved-env: base command', async () => {
        const response = await runCliText('saved-env-base-command', []);

        assert(response.stdout.includes(`Environment: ${config.environmentName}`), 'Base command output is missing the configured environment.');
        assert(response.stdout.includes('Authentication: OAuth client credentials'), 'Base command output is missing the OAuth authentication line.');
        assert(response.stdout.includes(`Host: ${config.host}`), 'Base command output is missing the configured host.');

        return {
            stdout: response.stdout.trim()
        };
    });

    await runConfiguredQueryChecks('saved-env', []);
    await runConfiguredCommandChecks('saved-env', []);

    const remoteRoot = path.posix.join(config.remoteRoot, runId, 'saved-env');
    cleanupTargets.push({
        name: 'saved-env',
        remoteRoot,
        authArgs: []
    });

    await runFileSuite('saved-env', localSourceDir, remoteRoot, []);
    await runInstallCheck('saved-env', []);
}

async function runEphemeralFlow(localSourceDir) {
    console.log('Running ephemeral flow...');

    const authArgs = getEphemeralAuthArgs();

    await runStep('ephemeral: root files list', async () => {
        const response = await runCliJson('ephemeral-files-root-list', ['files', '--list', '--output', 'json', ...authArgs]);
        assertEnvelope(response, 'files', 'list');

        return {
            rootName: response.data[0]?.name ?? '/'
        };
    });

    await runConfiguredQueryChecks('ephemeral', authArgs);
    await runConfiguredCommandChecks('ephemeral', authArgs);

    const remoteRoot = path.posix.join(config.remoteRoot, runId, 'ephemeral');
    cleanupTargets.push({
        name: 'ephemeral',
        remoteRoot,
        authArgs
    });

    await runFileSuite('ephemeral', localSourceDir, remoteRoot, authArgs);
}

async function runConfiguredQueryChecks(modeLabel, authArgs) {
    const enabledQueries = (config.queries || []).filter(query => query.enabled !== false);

    if (enabledQueries.length === 0) {
        skipStep(`${modeLabel}: query checks`, 'No queries configured.');
        return;
    }

    for (const query of enabledQueries) {
        if (query.checkList !== false) {
            await runStep(`${modeLabel}: query list ${query.name}`, async () => {
                const response = await runCliJson(`${modeLabel}-query-list-${query.name}`, [
                    'query',
                    query.name,
                    '--list',
                    '--output', 'json',
                    ...authArgs
                ]);

                assertEnvelope(response, 'query', 'list');

                return {
                    query: query.name,
                    parameters: response.data[0]
                };
            });
        }

        if (query.listOnly) {
            skipStep(`${modeLabel}: query run ${query.name}`, 'Skipped because listOnly is true.');
            continue;
        }

        await runStep(`${modeLabel}: query run ${query.name}`, async () => {
            const response = await runCliJson(`${modeLabel}-query-run-${query.name}`, [
                'query',
                query.name,
                ...serializeOptions(query.params),
                '--output', 'json',
                ...authArgs
            ]);

            assertEnvelope(response, 'query', 'run');

            return {
                query: query.name,
                resultCount: response.data.length
            };
        });
    }
}

async function runConfiguredCommandChecks(modeLabel, authArgs) {
    const enabledCommands = (config.commands || []).filter(command => command.enabled !== false);

    if (enabledCommands.length === 0) {
        skipStep(`${modeLabel}: command checks`, 'No commands configured.');
        return;
    }

    for (const command of enabledCommands) {
        await runStep(`${modeLabel}: command run ${command.name}`, async () => {
            const serializedParams = serializeOptions(command.params);
            const args = [
                'command',
                command.name,
                ...serializedParams,
                '--output', 'json',
                ...authArgs
            ];

            const body = resolveCommandBody(command);
            if (body !== null) {
                args.splice(2 + serializedParams.length, 0, '--json', body);
            }

            const response = await runCliJson(`${modeLabel}-command-run-${command.name}`, args);
            assertEnvelope(response, 'command', 'run');

            return {
                command: command.name,
                resultCount: response.data.length
            };
        });
    }
}

async function runFileSuite(modeLabel, localSourceDir, remoteRoot, authArgs) {
    const exportRoot = path.join(workspaceDir, `${modeLabel}-export`);
    const expectedLocalFile = path.join(localSourceDir, 'smoke-upload.txt');
    const expectedExportedFile = path.join(exportRoot, path.posix.basename(remoteRoot), 'smoke-upload.txt');

    await runStep(`${modeLabel}: files import`, async () => {
        const response = await runCliJson(`${modeLabel}-files-import`, [
            'files',
            localSourceDir,
            remoteRoot,
            '--import',
            '--recursive',
            '--overwrite',
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'import');
        assert((response.meta?.filesProcessed || 0) >= 4, 'Import did not process the expected number of fixture files.');

        return {
            remoteRoot,
            filesProcessed: response.meta.filesProcessed,
            chunks: response.meta.chunks
        };
    });

    await runStep(`${modeLabel}: files list imported tree`, async () => {
        const response = await runCliJson(`${modeLabel}-files-list-imported`, [
            'files',
            remoteRoot,
            '--list',
            '--recursive',
            '--includeFiles',
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'list');
        const listing = flattenListing(response.data[0], remoteRoot);

        assert(listing.files.includes(path.posix.join(remoteRoot, 'smoke-upload.txt')), 'Imported root file is missing from the remote listing.');
        assert(listing.files.includes(path.posix.join(remoteRoot, 'nested', 'nested-upload.txt')), 'Imported nested file is missing from the remote listing.');

        return {
            directories: listing.directories,
            files: listing.files
        };
    });

    await runStep(`${modeLabel}: files export`, async () => {
        fs.mkdirSync(exportRoot, { recursive: true });

        const response = await runCliJson(`${modeLabel}-files-export`, [
            'files',
            remoteRoot,
            exportRoot,
            '--export',
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'export');
        assert(fs.existsSync(expectedExportedFile), `Expected exported file was not found at ${expectedExportedFile}.`);

        const expectedContent = fs.readFileSync(expectedLocalFile, 'utf8');
        const exportedContent = fs.readFileSync(expectedExportedFile, 'utf8');
        assert(exportedContent === expectedContent, 'Exported file content does not match the uploaded fixture.');

        return {
            exportedFile: expectedExportedFile
        };
    });

    await runStep(`${modeLabel}: files copy`, async () => {
        const sourcePath = path.posix.join(remoteRoot, 'smoke-upload.txt');
        const destination = path.posix.join(remoteRoot, 'copied');
        const response = await runCliJson(`${modeLabel}-files-copy`, [
            'files',
            sourcePath,
            '--copy', destination,
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'copy');

        return {
            sourcePath,
            destination
        };
    });

    await runStep(`${modeLabel}: files verify copied`, async () => {
        const response = await runCliJson(`${modeLabel}-files-list-copied`, [
            'files',
            path.posix.join(remoteRoot, 'copied'),
            '--list',
            '--includeFiles',
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'list');
        const listing = flattenListing(response.data[0], path.posix.join(remoteRoot, 'copied'));
        assert(listing.files.includes(path.posix.join(remoteRoot, 'copied', 'smoke-upload.txt')), 'Copied file is missing from the destination directory.');

        return {
            files: listing.files
        };
    });

    await runStep(`${modeLabel}: files move`, async () => {
        const sourcePath = path.posix.join(remoteRoot, 'copied', 'smoke-upload.txt');
        const destination = path.posix.join(remoteRoot, 'moved');
        const response = await runCliJson(`${modeLabel}-files-move`, [
            'files',
            sourcePath,
            '--move', destination,
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'move');

        return {
            sourcePath,
            destination
        };
    });

    await runStep(`${modeLabel}: files verify moved`, async () => {
        const response = await runCliJson(`${modeLabel}-files-list-moved`, [
            'files',
            path.posix.join(remoteRoot, 'moved'),
            '--list',
            '--includeFiles',
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'list');
        const listing = flattenListing(response.data[0], path.posix.join(remoteRoot, 'moved'));
        assert(listing.files.includes(path.posix.join(remoteRoot, 'moved', 'smoke-upload.txt')), 'Moved file is missing from the destination directory.');

        return {
            files: listing.files
        };
    });

    await runStep(`${modeLabel}: files delete file`, async () => {
        const target = path.posix.join(remoteRoot, 'moved', 'smoke-upload.txt');
        const response = await runCliJson(`${modeLabel}-files-delete-file`, [
            'files',
            target,
            '--delete',
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'delete');

        return {
            deleted: target
        };
    });

    await runStep(`${modeLabel}: files verify deleted file`, async () => {
        const response = await runCliJson(`${modeLabel}-files-list-after-delete`, [
            'files',
            path.posix.join(remoteRoot, 'moved'),
            '--list',
            '--includeFiles',
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'files', 'list');
        const listing = flattenListing(response.data[0], path.posix.join(remoteRoot, 'moved'));
        assert(!listing.files.includes(path.posix.join(remoteRoot, 'moved', 'smoke-upload.txt')), 'Deleted file is still present in the destination directory.');

        return {
            files: listing.files
        };
    });
}

async function runInstallCheck(modeLabel, authArgs) {
    const installConfig = config.install || {};

    if (!installConfig.enabled) {
        skipStep(`${modeLabel}: install check`, 'Install is disabled in the QA profile.');
        return;
    }

    await runStep(`${modeLabel}: install check`, async () => {
        const filePath = path.resolve(repoRoot, installConfig.filePath);
        assert(fs.existsSync(filePath), `Install fixture was not found: ${filePath}`);

        const response = await runCliJson(`${modeLabel}-install`, [
            'install',
            filePath,
            ...(installConfig.queue ? ['--queue'] : []),
            '--output', 'json',
            ...authArgs
        ]);

        assertEnvelope(response, 'install', installConfig.queue ? 'queue' : 'install');

        return {
            filePath
        };
    });
}

async function cleanupRemoteTargets(alwaysAttempt) {
    if (args.keepRemote) {
        if (alwaysAttempt) {
            console.warn('Remote cleanup skipped because --keep-remote is enabled.');
        }
        return;
    }

    for (const target of cleanupTargets) {
        try {
            const response = await runCliJson(`cleanup-${target.name}`, [
                'files',
                target.remoteRoot,
                '--delete',
                '--output', 'json',
                ...target.authArgs
            ], {
                allowFailure: true
            });

            if (response?.ok) {
                console.log(`Cleaned remote folder for ${target.name}: ${target.remoteRoot}`);
            }
        } catch (error) {
            if (alwaysAttempt) {
                console.warn(`Best-effort cleanup failed for ${target.remoteRoot}: ${error.message}`);
            } else {
                throw error;
            }
        }
    }
}

async function runStep(name, fn) {
    const startedAt = new Date();
    const entry = {
        name,
        status: 'running',
        startedAt: startedAt.toISOString()
    };

    report.steps.push(entry);
    flushReport();

    try {
        const details = await fn();
        entry.status = 'passed';
        entry.details = details;
        entry.finishedAt = new Date().toISOString();
        entry.durationMs = new Date(entry.finishedAt).getTime() - startedAt.getTime();
        flushReport();
        console.log(`PASS ${name}`);
        return details;
    } catch (error) {
        entry.status = 'failed';
        entry.error = {
            message: error.message
        };
        entry.finishedAt = new Date().toISOString();
        entry.durationMs = new Date(entry.finishedAt).getTime() - startedAt.getTime();
        flushReport();
        console.error(`FAIL ${name}: ${error.message}`);
        throw error;
    }
}

function skipStep(name, reason) {
    report.steps.push({
        name,
        status: 'skipped',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        details: {
            reason
        }
    });
    flushReport();
    console.log(`SKIP ${name}: ${reason}`);
}

async function runCliJson(logName, cliArgs, options = {}) {
    const result = await runCli(logName, cliArgs, { ...options, expectJson: true });

    if (!result.parsed && !options.allowFailure) {
        throw new Error(`Expected JSON output from ${logName}, but stdout was empty.`);
    }

    return result.parsed;
}

async function runCliText(logName, cliArgs, options = {}) {
    return await runCli(logName, cliArgs, { ...options, expectJson: false });
}

async function runCli(logName, cliArgs, options = {}) {
    const command = [process.execPath, path.join('bin', 'index.js'), ...cliArgs];
    const timeoutMs = options.timeoutMs ?? config.commandTimeoutMs;
    const child = spawn(command[0], command.slice(1), {
        cwd: repoRoot,
        env: sharedEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
        stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });

    const timeoutHandle = setTimeout(() => {
        stderr += `\nProcess timed out after ${timeoutMs} ms.`;
        child.kill('SIGTERM');

        setTimeout(() => {
            if (!child.killed) {
                child.kill('SIGKILL');
            }
        }, 5000).unref();
    }, timeoutMs);

    const exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
    });
    clearTimeout(timeoutHandle);

    let parsed = null;
    if (options.expectJson && stdout.trim()) {
        try {
            parsed = JSON.parse(stdout);
        } catch (error) {
            throw new Error(`Failed to parse JSON output for ${logName}: ${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        }
    }

    const logPath = path.join(logsDir, `${String(report.steps.length).padStart(2, '0')}-${slugify(logName)}.json`);
    fs.writeFileSync(logPath, JSON.stringify({
        command,
        timeoutMs,
        exitCode,
        stdout,
        stderr,
        parsed
    }, null, 2));

    if (exitCode !== 0 && !options.allowFailure) {
        const details = parsed?.errors?.map(error => error.message).join('; ') || stderr.trim() || stdout.trim();
        throw new Error(`${logName} exited with code ${exitCode}. ${details}`);
    }

    return {
        exitCode,
        stdout,
        stderr,
        parsed,
        logPath
    };
}

function buildConfig(profile, cliArgs) {
    const merged = {
        ...defaultConfig,
        ...profile,
        install: {
            ...defaultConfig.install,
            ...(profile.install || {})
        }
    };

    const baseUrl = cliArgs.baseUrl || process.env.DW_BASE_URL || merged.baseUrl;
    assert(baseUrl, 'Missing base URL. Set DW_BASE_URL, add it to qa/profile.json, or pass --baseUrl.');

    const { protocol, host, normalizedBaseUrl } = normalizeBaseUrl(baseUrl);

    return {
        ...merged,
        protocol,
        host,
        baseUrl: normalizedBaseUrl,
        environmentName: cliArgs.environmentName || merged.environmentName,
        clientIdEnv: cliArgs.clientIdEnv || merged.clientIdEnv,
        clientSecretEnv: cliArgs.clientSecretEnv || merged.clientSecretEnv,
        remoteRoot: normalizeRemoteRoot(cliArgs.remoteRoot || merged.remoteRoot),
        commandTimeoutMs: parseTimeout(cliArgs.timeoutMs ?? merged.commandTimeoutMs),
        mode: cliArgs.mode,
        profilePath: profile.__profilePath || null
    };
}

function loadProfile(profilePathArg) {
    let profilePath = null;

    if (profilePathArg) {
        profilePath = path.resolve(repoRoot, profilePathArg);
        assert(fs.existsSync(profilePath), `Profile file not found: ${profilePath}`);
    } else if (fs.existsSync(defaultProfilePath)) {
        profilePath = defaultProfilePath;
    }

    if (!profilePath) {
        return { __profilePath: null };
    }

    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profile.__profilePath = profilePath;
    return profile;
}

function parseArgs(argv) {
    const parsed = {
        profile: null,
        mode: 'all',
        baseUrl: null,
        remoteRoot: null,
        environmentName: null,
        clientIdEnv: null,
        clientSecretEnv: null,
        timeoutMs: null,
        keepRemote: false,
        help: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
            continue;
        }

        if (arg === '--keep-remote') {
            parsed.keepRemote = true;
            continue;
        }

        const next = argv[index + 1];
        if (!next) {
            throw new Error(`Missing value for ${arg}`);
        }

        if (arg === '--profile') {
            parsed.profile = next;
            index += 1;
            continue;
        }

        if (arg === '--mode') {
            assert(['all', 'saved-env', 'ephemeral'].includes(next), `Invalid mode "${next}". Expected all, saved-env, or ephemeral.`);
            parsed.mode = next;
            index += 1;
            continue;
        }

        if (arg === '--baseUrl') {
            parsed.baseUrl = next;
            index += 1;
            continue;
        }

        if (arg === '--remoteRoot') {
            parsed.remoteRoot = next;
            index += 1;
            continue;
        }

        if (arg === '--environmentName') {
            parsed.environmentName = next;
            index += 1;
            continue;
        }

        if (arg === '--clientIdEnv') {
            parsed.clientIdEnv = next;
            index += 1;
            continue;
        }

        if (arg === '--clientSecretEnv') {
            parsed.clientSecretEnv = next;
            index += 1;
            continue;
        }

        if (arg === '--timeoutMs') {
            parsed.timeoutMs = next;
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return parsed;
}

function printHelp() {
    console.log(`
Usage:
  npm run qa:smoke
  npm run qa:smoke -- --profile qa/profile.json

Options:
  --profile <path>           Load a QA profile JSON file
  --mode <all|saved-env|ephemeral>
  --baseUrl <url>            Override the solution base URL
  --remoteRoot <path>        Override the remote QA root directory
  --environmentName <name>   Override the saved environment name
  --clientIdEnv <name>       Override the OAuth client ID env var name
  --clientSecretEnv <name>   Override the OAuth client secret env var name
  --timeoutMs <number>       Fail a CLI invocation if it runs longer than this
  --keep-remote              Leave remote QA folders behind for debugging
  --help                     Show this help

Defaults:
  profile: qa/profile.json if present, otherwise no profile
  base URL: DW_BASE_URL
  client ID env: DW_CLIENT_ID
  client secret env: DW_CLIENT_SECRET
  command timeout: 120000 ms
`.trim());

    if (fs.existsSync(exampleProfilePath)) {
        console.log(`\nExample profile: ${exampleProfilePath}`);
    }
}

function getEphemeralAuthArgs() {
    return [
        '--host', config.host,
        '--protocol', config.protocol,
        '--auth', 'oauth',
        '--clientIdEnv', config.clientIdEnv,
        '--clientSecretEnv', config.clientSecretEnv
    ];
}

function normalizeBaseUrl(rawValue) {
    const baseValue = /^https?:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;
    const parsed = new URL(baseValue);

    assert(!parsed.username && !parsed.password, 'The base URL must not include embedded credentials.');
    assert(!parsed.search && !parsed.hash, 'The base URL must not include a query string or hash fragment.');
    assert(parsed.pathname === '/' || parsed.pathname === '', 'The base URL must not include a path segment.');

    return {
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.host,
        normalizedBaseUrl: `${parsed.protocol}//${parsed.host}`
    };
}

function normalizeRemoteRoot(remoteRoot) {
    return remoteRoot.replace(/^\/+/, '').replace(/\/+$/, '');
}

function parseTimeout(rawValue) {
    const timeoutMs = Number(rawValue);
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, `Invalid timeout "${rawValue}". Expected a positive number of milliseconds.`);
    return timeoutMs;
}

function resolveCommandBody(command) {
    if (command.bodyFile) {
        const profileDir = config.profilePath ? path.dirname(config.profilePath) : repoRoot;
        const bodyFile = path.resolve(profileDir, command.bodyFile);
        assert(fs.existsSync(bodyFile), `Command body file not found: ${bodyFile}`);
        return fs.readFileSync(bodyFile, 'utf8');
    }

    if (command.body !== undefined) {
        return JSON.stringify(command.body);
    }

    return null;
}

function serializeOptions(options = {}) {
    const args = [];

    for (const [key, value] of Object.entries(options)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                args.push(`--${key}`, String(item));
            }
            continue;
        }

        if (typeof value === 'boolean') {
            args.push(`--${key}`, String(value));
            continue;
        }

        args.push(`--${key}`, String(value));
    }

    return args;
}

function flattenListing(root, rootPath = '') {
    const directories = rootPath ? [rootPath] : [];
    const files = [];

    walkListing(root, rootPath, directories, files, true);

    return { directories, files };
}

function walkListing(node, currentPath, directories, files, isRoot = false) {
    if (!isRoot && currentPath) {
        directories.push(currentPath);
    }

    for (const file of node?.files?.data || []) {
        files.push(path.posix.join(currentPath, file.name));
    }

    for (const directory of node?.directories || []) {
        walkListing(directory, path.posix.join(currentPath, directory.name), directories, files);
    }
}

function listFilesRecursively(rootDir) {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const resolved = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesRecursively(resolved));
        } else {
            files.push(resolved);
        }
    }

    return files.sort();
}

function assertEnvelope(response, command, operation) {
    assert(response, `No response received for ${command}.`);
    assert(response.command === command, `Expected command "${command}" but got "${response.command}".`);
    assert(response.operation === operation, `Expected operation "${operation}" but got "${response.operation}".`);
    assert(response.ok === true, `${command} returned a non-ok response.`);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function flushReport() {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function createRunId() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `qa-smoke-${timestamp}`;
}

function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
