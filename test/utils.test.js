import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes, formatElapsed } from '../bin/utils.js';

test('formatBytes formats zero bytes', () => {
    assert.equal(formatBytes(0), '0 Bytes');
});

test('formatBytes formats kilobytes and megabytes', () => {
    assert.equal(formatBytes(1024), '1.00 KB');
    assert.equal(formatBytes(1536), '1.50 KB');
    assert.equal(formatBytes(1024 * 1024), '1.00 MB');
});

test('formatBytes formats sub-kilobyte, gigabyte, and terabyte values', () => {
    assert.equal(formatBytes(500), '500.00 Bytes');
    assert.equal(formatBytes(1023), '1023.00 Bytes');
    assert.equal(formatBytes(1024 ** 3), '1.00 GB');
    assert.equal(formatBytes(1024 ** 4), '1.00 TB');
});

test('formatElapsed formats seconds, minutes, and hours', () => {
    assert.equal(formatElapsed(999), '0s');
    assert.equal(formatElapsed(1000), '1s');
    assert.equal(formatElapsed(5000), '5s');
    assert.equal(formatElapsed(61_000), '1m 1s');
    assert.equal(formatElapsed(120_000), '2m 0s');
    assert.equal(formatElapsed(3_661_000), '1h 1m 1s');
});

test('formatElapsed handles invalid inputs', () => {
    assert.equal(formatElapsed(-1000), '-1s');
    assert.equal(formatElapsed(null), '0s');
    assert.equal(formatElapsed(undefined), 'NaNs');
});
