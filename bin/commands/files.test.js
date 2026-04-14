import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUploadOutput } from './files.js';

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
