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

test('parseJsonOrPath throws SyntaxError for a file containing invalid JSON', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-test-'));
    const jsonPath = path.join(tempDir, 'bad.json');

    try {
        fs.writeFileSync(jsonPath, '{ not valid json }');
        assert.throws(() => parseJsonOrPath(jsonPath), SyntaxError);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('parseJsonOrPath throws SyntaxError for a non-existent file path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-test-'));

    try {
        const missingPath = path.join(tempDir, 'missing.json');
        // existsSync returns false, so the path string is passed to JSON.parse directly
        assert.throws(() => parseJsonOrPath(missingPath), SyntaxError);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
