import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getQueryParams, parseJsonOrPath } from '../bin/commands/command.js';

test('getQueryParams prefixes custom args and excludes framework args', () => {
    const params = getQueryParams({
        command: 'DoThing',
        host: 'example.com',
        protocol: 'https',
        verbose: true,
        id: 42,
        culture: 'en-US'
    });

    assert.deepEqual(params, {
        'Command.id': 42,
        'Command.culture': 'en-US'
    });
});

test('parseJsonOrPath returns undefined for empty input', () => {
    assert.equal(parseJsonOrPath(), undefined);
});

test('parseJsonOrPath parses literal json', () => {
    assert.deepEqual(parseJsonOrPath('{"model":{"id":123}}'), {
        model: {
            id: 123
        }
    });
});

test('parseJsonOrPath parses json from a file path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-test-'));
    const jsonPath = path.join(tempDir, 'body.json');

    try {
        fs.writeFileSync(jsonPath, '{"model":{"id":456}}');

        assert.deepEqual(parseJsonOrPath(jsonPath), {
            model: {
                id: 456
            }
        });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('parseJsonOrPath reports invalid JSON in a file as a command error', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-test-'));
    const jsonPath = path.join(tempDir, 'bad.json');

    try {
        fs.writeFileSync(jsonPath, '{ not valid json }');
        assert.throws(() => parseJsonOrPath(jsonPath), (err) => err.status === 400 && /Invalid JSON payload in .*bad\.json/.test(err.message));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('parseJsonOrPath reports a non-existent file path as neither JSON nor a file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-test-'));

    try {
        const missingPath = path.join(tempDir, 'missing.json');
        assert.throws(() => parseJsonOrPath(missingPath), (err) => err.status === 400 && /is neither/.test(err.message));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('parseJsonOrPath reports invalid literal JSON as a command error', () => {
    assert.throws(() => parseJsonOrPath('{ "model": '), (err) => err.status === 400 && /^Invalid JSON payload: /.test(err.message));
});
