import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { downloadWithProgress, getFileNameFromResponse, tryGetFileNameFromResponse } from '../bin/downloader.js';

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
    const mockLog = t.mock.method(console, 'error', () => { });

    assert.equal(tryGetFileNameFromResponse(response, '/Files'), null);
    assert.equal(mockLog.mock.calls.length, 0);
});

test('tryGetFileNameFromResponse logs the error message to stderr in verbose mode', (t) => {
    const response = createResponse(null);
    const mockLog = t.mock.method(console, 'error', () => { });

    assert.equal(tryGetFileNameFromResponse(response, '/Files', true), null);
    assert.equal(mockLog.mock.calls.length, 1);
    assert.match(String(mockLog.mock.calls[0].arguments[0]), /No files found in directory '\/Files'/);
});

test('getFileNameFromResponse handles quoted and RFC 5987 filenames', () => {
    assert.equal(getFileNameFromResponse(createResponse('attachment; filename="Templates.zip"'), '/Files'), 'Templates.zip');
    assert.equal(getFileNameFromResponse(createResponse("attachment; filename=a.zip; filename*=UTF-8''%C3%86bler.zip"), '/Files'), 'Æbler.zip');
});

test('getFileNameFromResponse never returns a path outside the output directory', () => {
    assert.equal(getFileNameFromResponse(createResponse('attachment; filename="../../evil.zip"'), '/Files'), 'evil.zip');
    assert.equal(getFileNameFromResponse(createResponse('attachment; filename=..\\evil.zip'), '/Files'), 'evil.zip');
});

test('downloadWithProgress rejects instead of crashing when the file cannot be written', async () => {
    const missingDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-dl-')), 'missing');
    const res = { body: Readable.from([Buffer.from('zip bytes')]) };

    await assert.rejects(downloadWithProgress(res, path.join(missingDir, 'a.zip')), { code: 'ENOENT' });
});

test('downloadWithProgress writes the body and reports progress', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-dl-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const seen = [];
    const res = { body: Readable.from([Buffer.from('ab'), Buffer.from('cde')]) };

    await downloadWithProgress(res, path.join(dir, 'a.zip'), { onData: (bytes) => seen.push(bytes) });
    assert.equal(fs.readFileSync(path.join(dir, 'a.zip'), 'utf8'), 'abcde');
    assert.deepEqual(seen, [2, 5]);
});
