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

test('tryGetFileNameFromResponse returns null and stays silent by default', (t) => {
    const response = createResponse(null);
    const mockLog = t.mock.method(console, 'log', () => { });

    assert.equal(tryGetFileNameFromResponse(response, '/Files'), null);
    assert.equal(mockLog.mock.calls.length, 0);
});

test('tryGetFileNameFromResponse logs the error message in verbose mode', (t) => {
    const response = createResponse(null);
    const mockLog = t.mock.method(console, 'log', () => { });

    assert.equal(tryGetFileNameFromResponse(response, '/Files', true), null);
    assert.equal(mockLog.mock.calls.length, 1);
    assert.match(String(mockLog.mock.calls[0].arguments[0]), /No files found in directory '\/Files'/);
});
