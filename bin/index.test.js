import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./index.js', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function versionFrom(cwd) {
    return execFileSync(process.execPath, [cli, '--version'], { cwd, encoding: 'utf8' }).trim();
}

test('--version reports the CLI version, not the working directory\'s', () => {
    // A directory holding an unrelated package.json: yargs would have guessed 99.99.99
    // by walking up from the cwd.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-version-'));
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'unrelated', version: '99.99.99' })
    );

    try {
        const output = versionFrom(dir);

        assert.ok(output.includes(pkg.version), `expected ${pkg.version}, got: ${output}`);
        assert.ok(!output.includes('99.99.99'), `leaked the cwd version: ${output}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('--version reports the CLI version with no package.json above the cwd', () => {
    // This is the reported case: from a directory such as C:\\Windows\\System32 the
    // guess found nothing and printed `unknown`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-version-bare-'));

    try {
        const output = versionFrom(dir);

        assert.ok(output.includes(pkg.version), `expected ${pkg.version}, got: ${output}`);
        assert.ok(!output.includes('unknown'), `still guessing: ${output}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
