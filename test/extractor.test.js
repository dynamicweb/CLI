import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractWithProgress } from '../bin/extractor.js';

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Builds a zip (stored, no compression) in memory.
 * entries: { name, data?, mode? } - mode is a unix st_mode, e.g. 0o120777 for a symlink.
 */
function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data = '', mode = 0o100644 } of entries) {
        const nameBuf = Buffer.from(name);
        const dataBuf = Buffer.from(data);
        const crc = crc32(dataBuf);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(dataBuf.length, 18);
        local.writeUInt32LE(dataBuf.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(dataBuf.length, 20);
        central.writeUInt32LE(dataBuf.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE((mode << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);

        locals.push(local, nameBuf, dataBuf);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + dataBuf.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, centralBuf, end]);
}

// Each test gets <tmp>/dest (extraction target) next to <tmp>/archive.zip, so an escape
// to the parent directory is observable.
async function extract(t, entries, options) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-extract-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const zip = path.join(tmp, 'archive.zip');
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest);
    fs.writeFileSync(zip, buildZip(entries));
    return { tmp, dest, run: () => extractWithProgress(zip, dest, options) };
}

test('extracts nested files and explicit directories', async (t) => {
    const { dest, run } = await extract(t, [
        { name: 'dir/', mode: 0o040755 },
        { name: 'dir/a.txt', data: 'hello' },
        { name: 'deep/er/b.txt', data: 'world' },
    ]);
    await run();
    assert.equal(fs.readFileSync(path.join(dest, 'dir/a.txt'), 'utf8'), 'hello');
    assert.equal(fs.readFileSync(path.join(dest, 'deep/er/b.txt'), 'utf8'), 'world');
});

test('reports progress for every extracted entry, skipping __MACOSX', async (t) => {
    const calls = [];
    const { dest, run } = await extract(t, [
        { name: 'a.txt', data: '1' },
        { name: '__MACOSX/._a.txt', data: 'junk' },
        { name: 'b.txt', data: '2' },
    ], { onEntry: (done, total, percent) => calls.push([done, total, percent]) });
    await run();
    assert.deepEqual(calls, [[1, 3, '33'], [2, 3, '66']]);
    assert.equal(fs.existsSync(path.join(dest, '__MACOSX')), false);
});

test('rejects ../ traversal and writes nothing outside the destination', async (t) => {
    const { tmp, run } = await extract(t, [{ name: '../evil.txt', data: 'x' }]);
    await assert.rejects(run, /relative path|Out of bound path/);
    assert.equal(fs.existsSync(path.join(tmp, 'evil.txt')), false);
});

test('rejects absolute entry paths', async (t) => {
    const target = path.join(os.tmpdir(), `dw-abs-${process.pid}.txt`);
    t.after(() => fs.rmSync(target, { force: true }));
    const { run } = await extract(t, [{ name: target, data: 'x' }]);
    await assert.rejects(run, /absolute path|Out of bound path/);
    assert.equal(fs.existsSync(target), false);
});

test('rejects a symlink whose target escapes the destination', async (t) => {
    const { dest, run } = await extract(t, [
        { name: 'link', data: '../outside', mode: 0o120777 },
    ]);
    await assert.rejects(run, /Out of bound path/);
    assert.equal(fs.existsSync(path.join(dest, 'link')), false);
});

test('rejects a symlink to an absolute path', async (t) => {
    const { dest, run } = await extract(t, [
        { name: 'link', data: os.tmpdir(), mode: 0o120777 },
    ]);
    await assert.rejects(run, /Out of bound path/);
    assert.equal(fs.existsSync(path.join(dest, 'link')), false);
});

test('blocks the write-through-symlink attack', async (t) => {
    const { tmp, dest, run } = await extract(t, [
        { name: 'link', data: '..', mode: 0o120777 },
        { name: 'link/pwned.txt', data: 'x' },
    ]);
    await assert.rejects(run, /Out of bound path/);
    assert.equal(fs.existsSync(path.join(tmp, 'pwned.txt')), false);
    assert.equal(fs.existsSync(path.join(dest, 'link')), false);
});

test('allows benign in-archive symlinks', async (t) => {
    const { dest, run } = await extract(t, [
        { name: 'real.txt', data: 'data' },
        { name: 'sub/link', data: '../real.txt', mode: 0o120777 },
    ]);
    // Creating symlinks needs privileges on Windows; skip when unavailable.
    try {
        await run();
    } catch (e) {
        if (e.code === 'EPERM') return t.skip('symlinks not permitted on this system');
        throw e;
    }
    assert.equal(fs.readlinkSync(path.join(dest, 'sub/link')).replaceAll('\\', '/'), '../real.txt');
});

test('allows file names that merely start with two dots', async (t) => {
    const { dest, run } = await extract(t, [{ name: '..hidden', data: 'x' }]);
    await run();
    assert.equal(fs.readFileSync(path.join(dest, '..hidden'), 'utf8'), 'x');
});

test('rejects a file that is not a zip archive', async (t) => {
    const { tmp, dest } = await extract(t, []);
    const bad = path.join(tmp, 'bad.zip');
    fs.writeFileSync(bad, 'not a zip');
    await assert.rejects(extractWithProgress(bad, dest));
});

// Directory links: junctions need no privileges on Windows; the type is ignored elsewhere.
function linkDir(target, at) {
    fs.symlinkSync(target, at, 'junction');
}

test('rejects writes through an existing link in the destination that points outside', async (t) => {
    const { tmp, dest, run } = await extract(t, [{ name: 'link/probe.txt', data: 'x' }]);
    const sibling = path.join(tmp, 'sibling');
    fs.mkdirSync(sibling);
    linkDir(sibling, path.join(dest, 'link'));

    await assert.rejects(run, /Out of bound path "link\/probe.txt"/);
    assert.deepEqual(fs.readdirSync(sibling), []);
});

test('rejects writes through an existing dangling link in the destination', async (t) => {
    const { tmp, dest, run } = await extract(t, [{ name: 'dangling/probe.txt', data: 'x' }]);
    const missing = path.join(tmp, 'not-yet');
    linkDir(missing, path.join(dest, 'dangling'));

    await assert.rejects(run, /Out of bound path/);
    assert.equal(fs.existsSync(missing), false);
});

test('rejects overwriting an existing file link that points outside', async (t) => {
    const { tmp, dest, run } = await extract(t, [{ name: 'file.txt', data: 'pwned' }]);
    const outside = path.join(tmp, 'outside.txt');
    fs.writeFileSync(outside, 'original');
    try {
        fs.symlinkSync(outside, path.join(dest, 'file.txt'), 'file');
    } catch (e) {
        if (e.code === 'EPERM') return t.skip('symlinks not permitted on this system');
        throw e;
    }

    await assert.rejects(run, /Out of bound path/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
});

test('allows writes through an existing link that stays inside the destination', async (t) => {
    const { dest, run } = await extract(t, [{ name: 'alias/probe.txt', data: 'x' }]);
    fs.mkdirSync(path.join(dest, 'inner'));
    linkDir(path.join(dest, 'inner'), path.join(dest, 'alias'));

    await run();
    assert.equal(fs.readFileSync(path.join(dest, 'inner/probe.txt'), 'utf8'), 'x');
});

test('allows a destination that is itself a link', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-extract-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    linkDir(real, path.join(tmp, 'dest'));
    const zip = path.join(tmp, 'archive.zip');
    fs.writeFileSync(zip, buildZip([{ name: 'a/b.txt', data: 'ok' }]));

    await extractWithProgress(zip, path.join(tmp, 'dest'));
    assert.equal(fs.readFileSync(path.join(real, 'a/b.txt'), 'utf8'), 'ok');
});
