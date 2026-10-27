import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The transfer state is saved to ~/.dwc: point the home directory at a temp folder
// before any CLI module resolves it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-home-'));
process.env.HOME = process.env.USERPROFILE = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

const { classifyProbeResponse, resolveTransfer, resolveTransferMode } = await import('../bin/transfer/index.js');
const { createFileTransferClient, isExcluded, localPathFor, toRemotePath } = await import('../bin/transfer/filetransfer.js');
const { createOutput } = await import('../bin/output.js');
const { setupConfig } = await import('../bin/commands/config.js');
const { startFakeFileTransfer } = await import('./helpers/fake-filetransfer.js');
setupConfig();
const quietOutput = () => createOutput({ command: 'files', operation: 'test', argv: { output: 'json' } });

// --- mode selection ---------------------------------------------------------------

test('resolveTransferMode: flag, then DW_TRANSFER, then config, then auto', () => {
    assert.deepEqual(resolveTransferMode({ transfer: 'legacy' }, { transfer: 'filetransfer' }, { DW_TRANSFER: 'filetransfer' }), { mode: 'legacy', source: 'flag' });
    assert.deepEqual(resolveTransferMode({}, { transfer: 'legacy' }, { DW_TRANSFER: 'FileTransfer' }), { mode: 'filetransfer', source: 'env' });
    assert.deepEqual(resolveTransferMode({}, { transfer: 'legacy' }, {}), { mode: 'legacy', source: 'config' });
    assert.deepEqual(resolveTransferMode({}, {}, { DW_TRANSFER: '' }), { mode: 'auto', source: 'default' });
});

test('resolveTransferMode rejects unknown modes and names where they came from', () => {
    assert.throws(() => resolveTransferMode({}, {}, { DW_TRANSFER: 'ftp' }), (err) => err.status === 400 && /"ftp" in DW_TRANSFER/.test(err.message));
    assert.throws(() => resolveTransferMode({}, { transfer: 'x' }, {}), /"transfer" setting/);
});

test('classifyProbeResponse: supported, unsupported, and auth failures are never "unsupported"', () => {
    assert.equal(classifyProbeResponse(200, { path: '', exists: true, isDirectory: true }), true);
    assert.equal(classifyProbeResponse(404, null), false);
    assert.throws(() => classifyProbeResponse(401, null), (err) => err.status === 401 && /Authentication failed/.test(err.message));
    assert.throws(() => classifyProbeResponse(403, null), (err) => err.status === 403);
    // A user without read permission on the files root still has the API.
    assert.equal(classifyProbeResponse(403, { code: 'FORBIDDEN', message: 'Read permission is required on the path.', path: '' }), true);
    assert.throws(() => classifyProbeResponse(200, '<html>'), /Unexpected response/);
    assert.throws(() => classifyProbeResponse(500, null), /HTTP 500/);
});

test('resolveTransfer: auto follows the probe and records the choice in meta', async () => {
    const env = { protocol: 'http', host: 'x' };
    for (const supported of [true, false]) {
        const output = quietOutput();
        const transfer = await resolveTransfer({}, env, { apiKey: 'k' }, output, { probe: async () => supported });
        assert.equal(transfer.name, supported ? 'filetransfer' : 'legacy');
        assert.equal(Boolean(transfer.client), supported);
        assert.deepEqual(output.response.meta, { transfer: transfer.name, transferSource: 'default' });
    }
});

test('resolveTransfer: forced filetransfer never falls back', async () => {
    await assert.rejects(
        resolveTransfer({ transfer: 'filetransfer' }, {}, {}, quietOutput(), { probe: async () => false }),
        /does not provide the File Transfer API/
    );
});

test('resolveTransfer: legacy-only operations use legacy under auto and fail when filetransfer is forced', async () => {
    let probed = false;
    const probe = async () => { probed = true; return true; };
    const transfer = await resolveTransfer({}, {}, {}, quietOutput(), { legacyOnly: true, probe });
    assert.equal(transfer.name, 'legacy');
    assert.equal(probed, false);
    await assert.rejects(resolveTransfer({ transfer: 'filetransfer' }, {}, {}, quietOutput(), { legacyOnly: true, probe }), /--raw/);
});

test('resolveTransfer: legacy never probes', async () => {
    const transfer = await resolveTransfer({ transfer: 'legacy' }, {}, {}, quietOutput(), { probe: async () => assert.fail('probed') });
    assert.equal(transfer.name, 'legacy');
});

// --- path helpers -----------------------------------------------------------------

test('toRemotePath normalizes CLI paths to files-root relative paths', () => {
    assert.equal(toRemotePath('/Files/Templates/x.cshtml'), 'Templates/x.cshtml');
    assert.equal(toRemotePath('Templates\\Designs\\'), 'Templates/Designs');
    assert.equal(toRemotePath('./a/./b'), 'a/b');
    assert.equal(toRemotePath('/'), '');
    assert.equal(toRemotePath(undefined), '');
    assert.equal(toRemotePath('FilesArchive/x'), 'FilesArchive/x');
});

test('isExcluded matches log and cache folders but not look-alikes', () => {
    assert.equal(isExcluded('System/Log'), true);
    assert.equal(isExcluded('system/log/2026/a.log'), true);
    assert.equal(isExcluded('cache.net/x'), true);
    assert.equal(isExcluded('System/Logos/a.png'), false);
    assert.equal(isExcluded('Templates/cache.net'), false);
});

test('localPathFor refuses paths that would leave the destination', () => {
    const root = path.resolve(os.tmpdir(), 'dw-dest');
    assert.equal(localPathFor(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
    for (const bad of ['../x', 'a/../../x', 'a//b', 'C:/x', 'a\\..\\x', '']) {
        assert.throws(() => localPathFor(root, bad), /unsafe path/, bad);
    }
});

// --- client against a fake File Transfer API ----------------------------------------

async function startFakeServer(t, options) {
    const fake = await startFakeFileTransfer(t, options);
    return { ...fake, client: createFileTransferClient(fake.env, { apiKey: 'k' }) };
}

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-ft-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('upload: chunked, checksummed, and retried on a retryable failure with the same idempotency key', async (t) => {
    const { client, store, requests } = await startFakeServer(t, { faults: { 'POST uploads': [503], 'PUT uploads/:id/chunks/1': [503] } });
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world'); // 3 chunks of 4 bytes
    const output = quietOutput();

    await client.uploadFiles([path.join(dir, 'a.txt')], '/Files/Docs', {}, output);

    assert.equal(store.get('Docs/a.txt').toString(), 'hello world');
    const creates = requests.filter(r => r.key === 'POST uploads');
    assert.equal(creates.length, 2);
    assert.ok(creates[0].idempotencyKey);
    assert.equal(creates[0].idempotencyKey, creates[1].idempotencyKey);
    assert.equal(output.response.meta.chunks, 3);
    assert.deepEqual(output.response.data[0].files, [path.join(dir, 'a.txt')]);
});

test('upload: existing and empty files are skipped like the legacy upload', async (t) => {
    const { client, store, requests } = await startFakeServer(t, { files: { 'Docs/a.txt': Buffer.from('old') } });
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    const output = quietOutput();

    await client.uploadFiles([path.join(dir, 'a.txt'), path.join(dir, 'empty.txt')], 'Docs', {}, output);

    assert.equal(store.get('Docs/a.txt').toString(), 'old');
    assert.equal(requests.filter(r => r.key === 'POST uploads').length, 0);
    assert.deepEqual(output.response.data[0].skipped.map(s => s.reason).sort(), ['empty', 'exists']);
});

test('upload: overwrite replaces, createEmpty uploads empty files', async (t) => {
    const { client, store } = await startFakeServer(t, { files: { 'Docs/a.txt': Buffer.from('old') } });
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');

    await client.uploadFiles([path.join(dir, 'a.txt'), path.join(dir, 'empty.txt')], 'Docs', { overwrite: true, createEmpty: true }, quietOutput());

    assert.equal(store.get('Docs/a.txt').toString(), 'new');
    assert.equal(store.get('Docs/empty.txt').length, 0);
});

test('upload: a file created during the upload is skipped and its session discarded', async (t) => {
    const { client, store, sessions } = await startFakeServer(t);
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'mine');
    const output = quietOutput();
    // A concurrent writer: the target appears after the directory listing, just before
    // the fake server's finalize checks for it.
    const has = store.has.bind(store);
    store.has = (key) => {
        if (key === 'Docs/a.txt' && !has(key)) store.set(key, Buffer.from('theirs'));
        return has(key);
    };

    await client.uploadFiles([path.join(dir, 'a.txt')], 'Docs', {}, output);

    assert.equal(store.get('Docs/a.txt').toString(), 'theirs');
    assert.equal(sessions.size, 0);
    assert.deepEqual(output.response.data[0].skipped.map(s => s.reason), ['exists']);
});

test('downloadDirectory: follows manifest pages, writes the tree, and leaves out logs', async (t) => {
    const { client } = await startFakeServer(t, {
        files: {
            'Templates/a.txt': Buffer.from('A'),
            'Templates/sub/b.txt': Buffer.from('B'),
            'Templates/sub/deeper/c.txt': Buffer.from('C'),
            'System/Log/x.log': Buffer.from('log'),
            'System/keep.txt': Buffer.from('keep')
        }
    });
    const out = tempDir(t);

    await client.downloadDirectory('/Files/Templates', out, {}, quietOutput());
    assert.equal(fs.readFileSync(path.join(out, 'Templates/sub/deeper/c.txt'), 'utf8'), 'C');
    assert.equal(fs.readFileSync(path.join(out, 'Templates/a.txt'), 'utf8'), 'A');

    await client.downloadDirectory('System', out, {}, quietOutput());
    assert.equal(fs.existsSync(path.join(out, 'System/keep.txt')), true);
    assert.equal(fs.existsSync(path.join(out, 'System/Log')), false);

    const all = tempDir(t);
    await client.downloadDirectory('System', all, { includeLogsAndCache: true }, quietOutput());
    assert.equal(fs.existsSync(path.join(all, 'System/Log/x.log')), true);
    assert.equal(fs.readdirSync(all, { recursive: true }).some(name => name.endsWith('.dwpart')), false);
});

test('list: builds the legacy tree shape from manifest pages', async (t) => {
    const { client } = await startFakeServer(t, { files: { 'T/a.txt': Buffer.from('A'), 'T/sub/b.txt': Buffer.from('BB') } });

    const tree = await client.list('T', true, true);

    assert.equal(tree.name, 'T');
    assert.deepEqual(tree.files.data.map(f => f.name), ['a.txt']);
    assert.equal(tree.directories[0].name, 'sub');
    assert.deepEqual(tree.directories[0].files.data.map(f => [f.name, f.size]), [['b.txt', 2]]);
});

test('list: a missing directory is an error', async (t) => {
    const { client } = await startFakeServer(t);
    await assert.rejects(client.list('Nope', false, true), (err) => err.status === 404 && /Unable to fetch file structure/.test(err.message));
});

test('copy keeps the legacy "into the destination folder" meaning', async (t) => {
    const { client, store } = await startFakeServer(t, { files: { 'Templates/config.json': '{}' } });
    const output = quietOutput();
    await client.copy('/Files/Templates/config.json', '/Templates/Backups', false, output);
    assert.equal(output.response.data[0].targetPath, 'Templates/Backups/config.json');
    assert.equal(store.get('Templates/Backups/config.json').toString(), '{}');
});
