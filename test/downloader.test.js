import test from 'node:test';
import assert from 'node:assert/strict';

import { getFileNameFromResponse, tryGetFileNameFromResponse } from '../bin/downloader.js';

function createResponse(contentDisposition) {
    return {
        headers: {
            get(name) {
                return name.toLowerCase() === 'content-disposition' ? contentDisposition : null;
            }
        }
    };
}

test('getFileNameFromResponse extracts the filename from content-disposition', () => {
    const response = createResponse('attachment; filename=My+Archive.zip');

    assert.equal(getFileNameFromResponse(response, '/Files'), 'My Archive.zip');
});

test('getFileNameFromResponse throws when no file metadata exists', () => {
    const response = createResponse(null);

    assert.throws(
        () => getFileNameFromResponse(response, '/Files'),
        /No files found in directory '\/Files'/
    );
});

test('tryGetFileNameFromResponse returns null and stays silent by default', () => {
    const response = createResponse(null);
    const originalLog = console.log;
    const calls = [];
    console.log = (...args) => {
        calls.push(args);
    };

    try {
        assert.equal(tryGetFileNameFromResponse(response, '/Files'), null);
        assert.deepEqual(calls, []);
    } finally {
        console.log = originalLog;
    }
});

test('tryGetFileNameFromResponse logs the error message in verbose mode', () => {
    const response = createResponse(null);
    const originalLog = console.log;
    const calls = [];
    console.log = (...args) => {
        calls.push(args);
    };

    try {
        assert.equal(tryGetFileNameFromResponse(response, '/Files', true), null);
        assert.equal(calls.length, 1);
        assert.match(String(calls[0][0]), /No files found in directory '\/Files'/);
    } finally {
        console.log = originalLog;
    }
});
