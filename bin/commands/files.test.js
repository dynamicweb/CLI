import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveFilePath, resolveUploadOutput } from './files.js';

test('resolveUploadOutput falls back to a console-compatible output object', () => {
    const output = resolveUploadOutput();

    assert.equal(typeof output.log, 'function');
    assert.equal(typeof output.addData, 'function');
    assert.equal(typeof output.mergeMeta, 'function');
    assert.deepEqual(output.response.meta, {});

    output.mergeMeta({ chunks: 1, filesProcessed: 2 });

    assert.deepEqual(output.response.meta, {
        chunks: 1,
        filesProcessed: 2
    });
});

test('resolveUploadOutput preserves custom logging and merges meta when mergeMeta is absent', () => {
    const calls = [];
    const data = [];
    const output = {
        log: (...args) => calls.push(args),
        addData: (entry) => data.push(entry),
        response: {
            meta: {
                existing: true
            }
        }
    };

    const resolved = resolveUploadOutput(output);

    resolved.log('Uploading chunk 1 of 1');
    resolved.addData({ file: 'addon.nupkg' });
    resolved.mergeMeta({ chunks: 1 });

    assert.deepEqual(calls, [[ 'Uploading chunk 1 of 1' ]]);
    assert.deepEqual(data, [{ file: 'addon.nupkg' }]);
    assert.deepEqual(resolved.response.meta, {
        existing: true,
        chunks: 1
    });
});

test('resolveUploadOutput initializes response.meta for partial output objects', () => {
    const resolved = resolveUploadOutput({
        log: () => {},
        response: {}
    });

    resolved.mergeMeta({ chunks: 2 });

    assert.deepEqual(resolved.response.meta, {
        chunks: 2
    });
});

test('resolveFilePath throws when no matching file exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cli-files-test-'));

    try {
        assert.throws(
            () => resolveFilePath(path.join(tempDir, 'missing*.nupkg')),
            /Could not find any files with the name/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
