import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The transfer state is saved to ~/.dwc: point the home directory at a temp folder
// before any CLI module resolves it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-home-'));
process.env.HOME = process.env.USERPROFILE = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

const { createFileTransferClient, mapPool } = await import('../bin/transfer/filetransfer.js');
const { applyPush, blockingConflicts, buildPlan, deploy, recordRemoteRoot, rollback, verifiedHashes } = await import('../bin/transfer/sync.js');
const { createOutput } = await import('../bin/output.js');
const { getConfig, setupConfig } = await import('../bin/commands/config.js');
const { startFakeFileTransfer } = await import('./helpers/fake-filetransfer.js');
setupConfig();

const cli = fileURLToPath(new URL('../bin/index.js', import.meta.url));
const quietOutput = () => createOutput({ command: 'files', operation: 'test', argv: { output: 'json' } });

function localTree(t, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-local-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, ...name.split('/'));
        if (content === null) {
            fs.mkdirSync(full, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }
    }
    return dir;
}

async function setup(t, options) {
    const fake = await startFakeFileTransfer(t, options);
    return { ...fake, client: createFileTransferClient(fake.env, { apiKey: 'k' }) };
}

const byPath = (plan) => Object.fromEntries(plan.items.map(item => [item.path, item.action]));
const checksumRequests = (requests) => requests.filter(r => r.key === 'GET entries/checksum').length;

// --- 1. diff -------------------------------------------------------------------------

test('plan classifies new, changed (by size and by content), unchanged and remote-only paths', async (t) => {
    const { client } = await setup(t, {
        files: { 'D/same.txt': 'same', 'D/size.txt': 'old', 'D/content.txt': 'aaaa', 'D/gone.txt': 'x', 'D/olddir/f.txt': 'y' }
    });
    const local = localTree(t, { 'same.txt': 'same', 'size.txt': 'longer', 'content.txt': 'bbbb', 'added.txt': 'n', 'emptydir': null });

    const plan = await buildPlan(client, { localRoot: local, remoteRoot: '/Files/D' });

    assert.deepEqual(byPath(plan), {
        'added.txt': 'new', 'content.txt': 'changed', 'emptydir': 'new', 'gone.txt': 'remote-only',
        'olddir': 'remote-only', 'olddir/f.txt': 'remote-only', 'same.txt': 'unchanged', 'size.txt': 'changed'
    });
    assert.deepEqual(plan.summary, { new: 1, changed: 2, unchanged: 1, remoteOnly: 2, conflicts: 0, directories: { new: 1, remoteOnly: 1 } });
    assert.equal(plan.syncedBefore, false);
});

test('plan of a missing remote directory: everything is new', async (t) => {
    const { client } = await setup(t);
    const plan = await buildPlan(client, { localRoot: localTree(t, { 'a.txt': 'a' }), remoteRoot: 'Nope' });
    assert.deepEqual(byPath(plan), { 'a.txt': 'new' });
    assert.equal(plan.remoteExists, false);
});

test('recorded hashes spare the server from re-hashing unchanged files', async (t) => {
    const { client, requests } = await setup(t, { files: { 'H/a.txt': 'aaaa', 'H/b.txt': 'bbbb' } });
    const local = localTree(t, { 'a.txt': 'aaaa', 'b.txt': 'bbbb' });

    await buildPlan(client, { localRoot: local, remoteRoot: 'H' });
    assert.equal(checksumRequests(requests), 2);
    client.state.save();

    const again = await buildPlan(client, { localRoot: local, remoteRoot: 'H' });
    assert.equal(checksumRequests(requests), 2, 'second plan used the recorded hashes');
    assert.equal(again.summary.unchanged, 2);
});

// --- 2/3. changed-only and sync ------------------------------------------------------------

test('sync uploads only changes, deletes only with deleteRemoteOnly, and leaves everything unchanged afterwards', async (t) => {
    const { client, store, explicitDirs, requests } = await setup(t, { files: { 'S/keep.txt': 'keep', 'S/edit.txt': 'v1', 'S/old/x.txt': 'x', 'S/stray.txt': 's' } });
    const local = localTree(t, { 'keep.txt': 'keep', 'edit.txt': 'v2 longer', 'new/n.txt': 'n', 'empty': null });

    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'S' });
    const kept = await applyPush(client, plan, {}, quietOutput());
    assert.deepEqual(kept.deleted, []);
    assert.equal(store.has('S/stray.txt'), true);

    const result = await applyPush(client, await buildPlan(client, { localRoot: local, remoteRoot: 'S' }), { deleteRemoteOnly: true }, quietOutput());
    assert.deepEqual(result.deleted.map(d => d.path).sort(), ['old', 'stray.txt'], 'a deleted directory takes its files along');
    assert.deepEqual([...store.keys()].sort(), ['S/edit.txt', 'S/keep.txt', 'S/new/n.txt']);
    assert.equal(store.get('S/edit.txt').toString(), 'v2 longer');
    assert.ok(explicitDirs.has('S/empty'), 'empty local directories are created');
    assert.equal(requests.filter(r => r.key === 'POST uploads').length, 2, 'unchanged keep.txt was never uploaded');

    await recordRemoteRoot(client, plan, verifiedHashes(plan, result.uploaded));
    const after = await buildPlan(client, { localRoot: local, remoteRoot: 'S' });
    assert.deepEqual(after.summary, { new: 0, changed: 0, unchanged: 3, remoteOnly: 0, conflicts: 0, directories: { new: 0, remoteOnly: 0 } });
    assert.equal(after.syncedBefore, true);
});

test('changed-only import keeps the import rules: no overwrite without it, no empty files without createEmpty', async (t) => {
    const { client, store } = await setup(t, { files: { 'I/a.txt': 'old' } });
    const local = localTree(t, { 'a.txt': 'new!', 'b.txt': 'b', 'empty.txt': '' });
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'I' });

    const result = await applyPush(client, plan, { overwrite: false, skipEmpty: true }, quietOutput());

    assert.equal(store.get('I/a.txt').toString(), 'old');
    assert.equal(store.has('I/empty.txt'), false);
    assert.deepEqual(result.uploaded.map(u => u.path), ['b.txt']);
    assert.deepEqual(result.skipped.map(s => `${s.path}:${s.reason}`).sort(), ['a.txt:exists', 'empty.txt:empty']);
});

test('changed-only export downloads only files that differ', async (t) => {
    const { client, requests } = await setup(t, { files: { 'E/a.txt': 'aaaa', 'E/b.txt': 'bbbb' } });
    const out = localTree(t, { 'E/a.txt': 'aaaa', 'E/b.txt': 'xxxx' });

    const output = quietOutput();
    await client.downloadDirectory('E', out, { changedOnly: true }, output);

    assert.equal(fs.readFileSync(path.join(out, 'E/b.txt'), 'utf8'), 'bbbb');
    assert.equal(requests.filter(r => r.key === 'GET entries/download').length, 1);
    assert.equal(output.response.data[0].skipped, 1);
});

// --- 4. resumable downloads ---------------------------------------------------------------

test('a download that drops mid-file resumes with a range request', async (t) => {
    const content = 'x'.repeat(1000) + 'END';
    const { client, requests } = await setup(t, { files: { 'R/big.bin': content }, faults: { 'DROP R/big.bin': [1] } });
    const out = localTree(t, {});

    await client.downloadEntry('R/big.bin', path.join(out, 'big.bin'));

    assert.equal(fs.readFileSync(path.join(out, 'big.bin'), 'utf8'), content);
    const downloads = requests.filter(r => r.key === 'GET entries/download');
    assert.equal(downloads.length, 2);
    assert.match(downloads[1].headers.range, /^bytes=\d+-$/);
    assert.ok(downloads[1].headers['if-range']);
    assert.deepEqual(fs.readdirSync(out), ['big.bin']);
});

test('a partial download of an older version is discarded, not spliced', async (t) => {
    const { client, eTagOf } = await setup(t, { files: { 'R/f.txt': 'NEW CONTENT' } });
    const out = localTree(t, {});
    const target = path.join(out, 'f.txt');
    fs.writeFileSync(`${target}.deadbeef-1.dwpart`, 'OLD');
    // A partial of the current version is a valid prefix and is resumed.
    fs.writeFileSync(`${target}.${eTagOf('R/f.txt').replace(/[^0-9a-z-]/gi, '')}.dwpart`, 'NEW');

    await client.downloadEntry('R/f.txt', target);

    assert.equal(fs.readFileSync(target, 'utf8'), 'NEW CONTENT');
    assert.deepEqual(fs.readdirSync(out), ['f.txt']);
});

// --- 6. remote changes ------------------------------------------------------------------

test('after a sync, files edited or added on the server are conflicts', async (t) => {
    const { client, edit } = await setup(t, { files: { 'C/a.txt': 'a', 'C/b.txt': 'b' } });
    const local = localTree(t, { 'a.txt': 'local a', 'b.txt': 'b' });
    const first = await buildPlan(client, { localRoot: local, remoteRoot: 'C' });
    assert.equal(first.summary.conflicts, 0, 'nothing to compare with before the first sync');
    const pushed = await applyPush(client, first, {}, quietOutput());
    await recordRemoteRoot(client, first, verifiedHashes(first, pushed.uploaded));

    edit('C/b.txt', 'edited on the server');
    edit('C/extra.txt', 'added on the server');
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'C' });

    assert.deepEqual(plan.items.filter(i => i.conflict).map(i => `${i.path}:${i.conflict}`).sort(), ['b.txt:modified-remotely', 'extra.txt:added-remotely']);
    assert.deepEqual(blockingConflicts(plan).map(i => i.path), ['b.txt'], 'a remote-only file only blocks when it would be deleted');
    assert.deepEqual(blockingConflicts(plan, { deleteRemoteOnly: true }).map(i => i.path).sort(), ['b.txt', 'extra.txt']);
});

test('guarded push refuses to overwrite a file changed after planning', async (t) => {
    const { client, store, edit } = await setup(t, { files: { 'G/a.txt': 'a' } });
    const plan = await buildPlan(client, { localRoot: localTree(t, { 'a.txt': 'mine' }), remoteRoot: 'G' });
    edit('G/a.txt', 'theirs');

    await assert.rejects(applyPush(client, plan, { guard: true }, quietOutput()), (err) => err.status === 409 && err.details.code === 'REMOTE_CHANGED');
    assert.equal(store.get('G/a.txt').toString(), 'theirs');
});

// --- 7. deploy and rollback ---------------------------------------------------------------

test('deploy swaps in the new version, keeps one backup on request, and rollback restores it', async (t) => {
    const { client, store } = await setup(t, { files: { 'Designs/X/a.css': 'v1', 'Designs/X/old.js': 'old', 'Designs/Y/keep.txt': 'y' } });
    const local = localTree(t, { 'a.css': 'version 2', 'new.js': 'n' });

    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'Designs/X' });
    const result = await deploy(client, plan, { keepBackup: true }, quietOutput());

    const live = [...store.keys()].filter(k => k.startsWith('Designs/X/')).sort();
    assert.deepEqual(live, ['Designs/X/a.css', 'Designs/X/new.js']);
    assert.equal(store.get('Designs/X/a.css').toString(), 'version 2');
    assert.match(result.backupPath, /^Designs\/X\.dwbackup-\d{14}$/);
    assert.equal(store.get(`${result.backupPath}/old.js`).toString(), 'old');
    assert.equal([...store.keys()].some(k => k.includes('.dwdeploy-')), false, 'staging is gone');
    assert.equal(store.get('Designs/Y/keep.txt').toString(), 'y');

    await rollback(client, 'Designs/X', quietOutput());
    assert.deepEqual([...store.keys()].filter(k => k.startsWith('Designs/X')).sort(), ['Designs/X/a.css', 'Designs/X/old.js']);
    assert.equal(store.get('Designs/X/a.css').toString(), 'v1');
    await assert.rejects(rollback(client, 'Designs/X', quietOutput()), (err) => err.status === 404);
});

test('deploy without keepBackup leaves no backup, and a failed upload leaves the live version untouched', async (t) => {
    const { client, store } = await setup(t, { files: { 'D/X/a.txt': 'v1' }, faults: { 'POST uploads/:id/finalize': [422, 422, 422, 422] } });
    const plan = await buildPlan(client, { localRoot: localTree(t, { 'a.txt': 'v2!' }), remoteRoot: 'D/X' });

    await assert.rejects(deploy(client, plan, {}, quietOutput()));
    assert.deepEqual([...store.keys()], ['D/X/a.txt']);
    assert.equal(store.get('D/X/a.txt').toString(), 'v1');

    const retry = await buildPlan(client, { localRoot: localTree(t, { 'a.txt': 'v2!' }), remoteRoot: 'D/X' });
    await deploy(client, retry, {}, quietOutput());
    assert.deepEqual([...store.keys()], ['D/X/a.txt']);
    assert.equal(store.get('D/X/a.txt').toString(), 'v2!');
});

test('deploy into a directory that does not exist yet', async (t) => {
    const { client, store } = await setup(t);
    const plan = await buildPlan(client, { localRoot: localTree(t, { 'a.txt': 'a' }), remoteRoot: 'Fresh/Site' });
    const result = await deploy(client, plan, { keepBackup: true }, quietOutput());
    assert.equal(store.get('Fresh/Site/a.txt').toString(), 'a');
    assert.equal(result.backupPath, null);
});

// --- 8. verify ----------------------------------------------------------------------------

test('verify rejects and removes a download that does not match the server checksum', async (t) => {
    const { client } = await setup(t, { files: { 'V/f.txt': 'genuine' }, faults: { 'CORRUPT V/f.txt': [1] } });
    const out = localTree(t, {});
    await assert.rejects(client.downloadEntry('V/f.txt', path.join(out, 'f.txt'), { verify: true }), (err) => err.status === 422 && err.details.code === 'CHECKSUM_MISMATCH');
    assert.equal(fs.existsSync(path.join(out, 'f.txt')), false);

    const ok = await client.downloadEntry('V/f.txt', path.join(out, 'f.txt'), { verify: true });
    assert.equal(ok.verified, true);
});

// --- the commands, end to end -----------------------------------------------------------------

function dw(fake, args, cwd) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cli, ...args, '--host', fake.env.host, '--protocol', 'http', '--apiKey', 'k', '--output', 'json'],
            { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, MSYSTEM: '' } },
            (error, stdout, stderr) => {
                let json = null;
                try { json = JSON.parse(stdout); } catch { }
                resolve({ code: error?.code ?? 0, json, stdout, stderr });
            });
    });
}

test('dw files diff / sync / stat / usage', async (t) => {
    const fake = await startFakeFileTransfer(t, { files: { 'Site/a.txt': 'a', 'Site/stray.txt': 's' } });
    const local = localTree(t, { 'a.txt': 'a', 'b.txt': 'bb' });

    const diff = await dw(fake, ['files', 'diff', local, 'Site']);
    assert.equal(diff.code, 0, diff.stdout);
    assert.deepEqual(diff.json.data[0].summary, { new: 1, changed: 0, unchanged: 1, remoteOnly: 1, conflicts: 0, directories: { new: 0, remoteOnly: 0 } });
    assert.equal(diff.json.meta.transfer, 'filetransfer');

    const dry = await dw(fake, ['files', 'sync', local, 'Site', '--delete', '--dry-run']);
    assert.equal(dry.json.data[0].dryRun, true);
    assert.equal(fake.store.has('Site/stray.txt'), true);

    const sync = await dw(fake, ['files', 'sync', local, 'Site', '--delete']);
    assert.equal(sync.code, 0, sync.stdout);
    assert.deepEqual([...fake.store.keys()].sort(), ['Site/a.txt', 'Site/b.txt']);

    fake.edit('Site/a.txt', 'changed on the server');
    fs.writeFileSync(path.join(local, 'a.txt'), 'changed locally');
    const guarded = await dw(fake, ['files', 'sync', local, 'Site', '--fail-on-remote-change']);
    assert.equal(guarded.code, 1);
    assert.equal(guarded.json.errors[0].details.code, 'REMOTE_CHANGED');
    assert.equal(fake.store.get('Site/a.txt').toString(), 'changed on the server');

    const stat = await dw(fake, ['files', 'stat', 'Site/b.txt', '--checksum']);
    assert.equal(stat.json.data[0].size, 2);
    assert.match(stat.json.data[0].sha256, /^[0-9a-f]{64}$/);

    const usage = await dw(fake, ['files', 'usage', 'Site']);
    assert.deepEqual([usage.json.data[0].fileCount, usage.json.data[0].totalBytes], [2, 23]);

    const state = JSON.parse(fs.readFileSync(path.join(home, '.dwc'), 'utf8')).transferState;
    assert.ok(state[`http://${fake.env.host}`].roots.site, 'the sync was recorded in ~/.dwc');
});

test('dw files deploy --keep-backup / rollback, and --changed-only / --verify on import and export', async (t) => {
    const fake = await startFakeFileTransfer(t, { files: { 'Web/X/a.txt': 'v1' } });
    const local = localTree(t, { 'a.txt': 'v2', 'b.txt': 'b' });

    const deployed = await dw(fake, ['files', 'deploy', local, 'Web/X', '--keep-backup']);
    assert.equal(deployed.code, 0, deployed.stdout);
    assert.ok(deployed.json.data[0].backupPath);
    assert.equal(fake.store.get('Web/X/a.txt').toString(), 'v2');

    const rolledBack = await dw(fake, ['files', 'rollback', 'Web/X']);
    assert.equal(rolledBack.code, 0, rolledBack.stdout);
    assert.equal(fake.store.get('Web/X/a.txt').toString(), 'v1');

    const imported = await dw(fake, ['files', local, 'Web/X', '-i', '-o', '--changed-only']);
    assert.equal(imported.code, 0, imported.stdout);
    assert.deepEqual(imported.json.data[0].results.map(r => path.basename(r.file)).sort(), ['a.txt', 'b.txt']);
    const again = await dw(fake, ['files', local, 'Web/X', '-i', '-o', '--changed-only']);
    assert.deepEqual(again.json.data[0].results, []);
    assert.deepEqual(again.json.data[0].skipped.map(s => s.reason), ['unchanged', 'unchanged']);

    const out = localTree(t, {});
    const exported = await dw(fake, ['files', 'Web/X', out, '-e', '--verify']);
    assert.equal(exported.code, 0, exported.stdout);
    assert.equal(exported.json.data[0].verified, true);
    assert.equal(fs.readFileSync(path.join(out, 'X/a.txt'), 'utf8'), 'v2');
});

test('the new commands and options refuse to run with the legacy transfer', async (t) => {
    const fake = await startFakeFileTransfer(t, { files: { 'L/a.txt': 'a' } });
    const local = localTree(t, { 'a.txt': 'a' });
    for (const args of [['files', 'diff', local, 'L'], ['files', local, 'L', '-i', '--changed-only'], ['files', 'L', local, '-e', '--verify']]) {
        const result = await dw(fake, [...args, '--transfer', 'legacy']);
        assert.equal(result.code, 1, args.join(' '));
        assert.match(result.json.errors[0].message, /requires the File Transfer API, but the legacy transfer was selected \(--transfer\)/);
    }
    assert.ok(getConfig());
});

// --- review regressions -----------------------------------------------------------------------

async function syncOnce(client, local, remoteRoot, options = {}) {
    const plan = await buildPlan(client, { localRoot: local, remoteRoot });
    const result = await applyPush(client, plan, options, quietOutput());
    await recordRemoteRoot(client, plan, verifiedHashes(plan, result.uploaded));
    return result;
}

test('a same-size remote edit stays a conflict even though planning checksums it', async (t) => {
    const { client, edit } = await setup(t, { files: { 'P/b.txt': 'bbbb' } });
    const local = localTree(t, { 'b.txt': 'bbbb' });
    await syncOnce(client, local, 'P');

    edit('P/b.txt', 'cccc');                         // same size: only the hash tells
    fs.writeFileSync(path.join(local, 'b.txt'), 'dddd');
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'P' });
    await client.checksum('P/b.txt');                // e.g. "dw files stat --checksum"
    const again = await buildPlan(client, { localRoot: local, remoteRoot: 'P' });

    for (const p of [plan, again]) {
        assert.deepEqual(blockingConflicts(p).map(i => `${i.path}:${i.conflict}`), ['b.txt:modified-remotely']);
    }
});

test('a file skipped for lack of --overwrite is not recorded as matching the local file', async (t) => {
    const { client, store } = await setup(t, { files: { 'I/a.txt': 'old!' } });
    const local = localTree(t, { 'a.txt': 'new!' });

    await syncOnce(client, local, 'I', { overwrite: false });
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'I' });
    assert.deepEqual(byPath(plan), { 'a.txt': 'changed' });

    await syncOnce(client, local, 'I', { overwrite: true });
    assert.equal(store.get('I/a.txt').toString(), 'new!');
});

test('a remote-only file left in place by sync still blocks a later --delete', async (t) => {
    const { client, edit } = await setup(t, { files: { 'K/a.txt': 'a' } });
    const local = localTree(t, { 'a.txt': 'a' });
    await syncOnce(client, local, 'K');

    edit('K/hotfix.txt', 'added on the server');
    await syncOnce(client, local, 'K');               // without --delete: left alone
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'K' });

    assert.deepEqual(blockingConflicts(plan, { deleteRemoteOnly: true }).map(i => `${i.path}:${i.conflict}`), ['hotfix.txt:added-remotely']);
});

test('a same-size remote edit between the push and recording the baseline stays a conflict', async (t) => {
    const { client, edit } = await setup(t, { files: { 'B/a.txt': 'aaaa', 'B/b.txt': 'bbbb' } });
    const local = localTree(t, { 'a.txt': 'AAAA', 'b.txt': 'bbbb' });
    await syncOnce(client, local, 'B');

    fs.writeFileSync(path.join(local, 'a.txt'), 'XXXX');
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'B' });
    const result = await applyPush(client, plan, {}, quietOutput());
    edit('B/a.txt', 'zzzz');                         // after the upload: same size
    edit('B/b.txt', 'yyyy');                         // after planning found it unchanged
    await recordRemoteRoot(client, plan, verifiedHashes(plan, result.uploaded));

    const after = await buildPlan(client, { localRoot: local, remoteRoot: 'B' });
    assert.deepEqual(blockingConflicts(after).map(i => `${i.path}:${i.conflict}`), ['a.txt:modified-remotely', 'b.txt:modified-remotely']);
});

test('a guarded delete never takes a file changed after planning along with its directory', async (t) => {
    const { client, store, edit } = await setup(t, { files: { 'Q/keep.txt': 'k', 'Q/old/a.txt': 'a', 'Q/old/sub/b.txt': 'b' }, directories: ['Q/old', 'Q/old/sub'] });
    const local = localTree(t, { 'keep.txt': 'k' });
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'Q' });
    edit('Q/old/sub/b.txt', 'edited');

    await assert.rejects(applyPush(client, plan, { deleteRemoteOnly: true, guard: true }, quietOutput()),
        (err) => err.status === 409 && err.details.code === 'REMOTE_CHANGED' && err.details.path === 'old/sub/b.txt');
    assert.equal(store.get('Q/old/sub/b.txt').toString(), 'edited');
});

test('a guarded delete never takes a file added after planning along with its directory', async (t) => {
    const { client, store, edit } = await setup(t, { files: { 'Q/keep.txt': 'k', 'Q/old/a.txt': 'a' }, directories: ['Q/old'] });
    const local = localTree(t, { 'keep.txt': 'k' });
    const plan = await buildPlan(client, { localRoot: local, remoteRoot: 'Q' });
    edit('Q/old/added.txt', 'new on the server');

    await assert.rejects(applyPush(client, plan, { deleteRemoteOnly: true, guard: true }, quietOutput()),
        (err) => err.status === 409 && err.details.code === 'REMOTE_CHANGED' && err.details.added.includes('old/added.txt'));
    assert.equal(store.get('Q/old/added.txt').toString(), 'new on the server');
    assert.equal(store.has('Q/old/a.txt'), false, 'the planned file was deleted');
});

test('a guarded delete removes planned files and directories when nothing changed', async (t) => {
    const { client, store, explicitDirs } = await setup(t, { files: { 'Q/keep.txt': 'k', 'Q/old/a.txt': 'a', 'Q/old/sub/b.txt': 'b' }, directories: ['Q/old', 'Q/old/sub'] });
    const plan = await buildPlan(client, { localRoot: localTree(t, { 'keep.txt': 'k' }), remoteRoot: 'Q' });

    const result = await applyPush(client, plan, { deleteRemoteOnly: true, guard: true }, quietOutput());

    assert.deepEqual([...store.keys()], ['Q/keep.txt']);
    assert.equal([...explicitDirs].some(d => d.startsWith('Q/old')), false);
    assert.deepEqual(result.deleted.map(d => d.path), ['old/a.txt', 'old/sub/b.txt', 'old/sub', 'old']);
});

test('mapPool starts nothing new after a failure and rejects only once running work has finished', async () => {
    const events = [];
    await assert.rejects(mapPool([1, 2, 3, 4, 5], 2, async (n) => {
        events.push(`start ${n}`);
        if (n === 1) throw new Error('boom');
        await new Promise(resolve => setTimeout(resolve, 20));
        events.push(`end ${n}`);
    }), /boom/);
    events.push('rejected');

    assert.deepEqual(events, ['start 1', 'start 2', 'end 2', 'rejected']);
});

function linkDir(target, at) {
    fs.symlinkSync(target, at, 'junction');
}

test('an export never writes through a link inside the destination', async (t) => {
    const { client } = await setup(t, { files: { 'E/link/a.txt': 'payload', 'E/b.txt': 'b' } });
    const root = localTree(t, {});
    const out = path.join(root, 'out');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(out, 'E'), { recursive: true });
    fs.mkdirSync(outside);
    linkDir(outside, path.join(out, 'E', 'link'));

    await assert.rejects(client.downloadDirectory('E', out, {}, quietOutput()), /link or junction leads outside/);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('an export never writes through a link at the export folder itself', async (t) => {
    const { client } = await setup(t, { files: { 'E/a.txt': 'payload' } });
    const root = localTree(t, {});
    const out = path.join(root, 'out');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(out);
    fs.mkdirSync(outside);
    linkDir(outside, path.join(out, 'E'));

    await assert.rejects(client.downloadDirectory('E', out, {}, quietOutput()), /link or junction leads outside/);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('a single-file export never overwrites a file link pointing outside', async (t) => {
    const { client } = await setup(t, { files: { 'F/a.txt': 'payload' } });
    const root = localTree(t, {});
    const out = path.join(root, 'out');
    const victim = path.join(root, 'victim.txt');
    fs.mkdirSync(out);
    fs.writeFileSync(victim, 'original');
    try {
        fs.symlinkSync(victim, path.join(out, 'a.txt'), 'file');
    } catch (e) {
        if (e.code === 'EPERM') return t.skip('symlinks not permitted on this system');
        throw e;
    }

    await assert.rejects(client.downloadFile('F/a.txt', out, quietOutput()), /link or junction leads outside/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'original');
});

test('links that stay inside the destination, and a destination that is a link, still work', async (t) => {
    const { client } = await setup(t, { files: { 'E/alias/a.txt': 'payload' } });
    const root = localTree(t, {});
    const realOut = path.join(root, 'real-out');
    fs.mkdirSync(path.join(realOut, 'E', 'inner'), { recursive: true });
    linkDir(path.join(realOut, 'E', 'inner'), path.join(realOut, 'E', 'alias'));
    linkDir(realOut, path.join(root, 'out'));

    await client.downloadDirectory('E', path.join(root, 'out'), {}, quietOutput());
    assert.equal(fs.readFileSync(path.join(realOut, 'E', 'inner', 'a.txt'), 'utf8'), 'payload');
});
