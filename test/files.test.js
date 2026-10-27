import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
    getFilesOperation,
    getFilesStructure,
    isFilePath,
    prepareDownloadCommandData,
    resolveFilePath,
    wildcardToRegExp
} from '../bin/commands/files.js';

test('prepareDownloadCommandData uses directory download for recursive folder exports', () => {
    const result = prepareDownloadCommandData('/Files', 'system/log', [], true, false);

    assert.equal(result.endpoint, 'DirectoryDownload');
    assert.deepEqual(result.data, {
        DirectoryPath: '/Files',
        ExcludeDirectories: ['system/log']
    });
});

test('prepareDownloadCommandData uses file download for single-file exports', () => {
    const result = prepareDownloadCommandData('/Files', '', ['/Files/logo.png'], false, true);

    assert.equal(result.endpoint, 'FileDownload');
    assert.deepEqual(result.data, {
        DirectoryPath: '/Files',
        ExcludeDirectories: [''],
        Ids: ['/Files/logo.png']
    });
});

test('isFilePath respects explicit overrides before extension detection', () => {
    assert.equal(isFilePath({ asFile: true }, 'folder.with.dot'), true);
    assert.equal(isFilePath({ asDirectory: true }, 'file.txt'), false);
    assert.equal(isFilePath({}, 'file.txt'), true);
    assert.equal(isFilePath({}, 'folder'), false);
});

test('wildcardToRegExp escapes regex characters and expands asterisks', () => {
    const regex = wildcardToRegExp('plugin-*.dll');

    assert.equal(regex.test('plugin-core.dll'), true);
    assert.equal(regex.test('plugin-core.dll.bak'), false);
    assert.equal(regex.test('plugin-(core).dll'), true);
});

test('resolveFilePath resolves wildcard matches from the target directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-files-test-'));

    try {
        fs.writeFileSync(path.join(tempDir, 'plugin-core.dll'), '');
        fs.writeFileSync(path.join(tempDir, 'plugin-extra.nupkg'), '');

        const resolved = resolveFilePath(path.join(tempDir, 'plugin-*.dll'));

        assert.equal(resolved, path.join(tempDir, 'plugin-core.dll'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('resolveFilePath throws when the wildcard finds no match', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-files-test-'));

    try {
        assert.throws(
            () => resolveFilePath(path.join(tempDir, '*.dll')),
            /Could not find any files with the name/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('getFilesOperation reports the selected files subcommand', () => {
    assert.equal(getFilesOperation({ list: true }), 'list');
    assert.equal(getFilesOperation({ export: true }), 'export');
    assert.equal(getFilesOperation({ import: true }), 'import');
    assert.equal(getFilesOperation({ delete: true }), 'delete');
    assert.equal(getFilesOperation({ copy: '/dest' }), 'copy');
    assert.equal(getFilesOperation({ move: '/dest' }), 'move');
    assert.equal(getFilesOperation({}), 'unknown');
});

/** Serves DirectoryAll with the given model, the way the Management API answers. */
async function startDirectoryAll(t, model) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return { protocol: 'http', host: `127.0.0.1:${server.address().port}` };
}

test('getFilesStructure returns a real directory', async (t) => {
    const env = await startDirectoryAll(t, { modelIdentifier: '/Files/images', name: 'images', directories: [] });

    const result = await getFilesStructure(env, { apiKey: 'k' }, 'images', false, true);

    assert.equal(result.model.modelIdentifier, '/Files/images');
});

test('getFilesStructure rejects the placeholder for a missing or unreadable directory', async (t) => {
    const env = await startDirectoryAll(t, { modelIdentifier: '', name: '', directoryPath: '', directories: [], files: { data: [] } });

    await assert.rejects(getFilesStructure(env, { apiKey: 'k' }, 'templates', false, true), (err) =>
        err.status === 404
        && err.details.code === 'NOT_FOUND'
        && err.details.path === 'templates'
        && /no permission to read it/.test(err.details.message));
});
