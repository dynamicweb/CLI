import test from 'node:test';
import assert from 'node:assert/strict';

import { createInstallOutput } from './install.js';

test('createInstallOutput suppresses regular logs in json mode and emits the final envelope', () => {
    const logCalls = [];
    const infoCalls = [];
    const originalLog = console.log;
    const originalInfo = console.info;

    console.log = (...args) => logCalls.push(args);
    console.info = (...args) => infoCalls.push(args);

    try {
        const output = createInstallOutput({
            output: 'json',
            queue: true,
            verbose: true
        });

        output.log('hidden');
        output.verboseLog('hidden verbose');
        output.addData({ type: 'install', filename: 'addon.nupkg' });
        output.mergeMeta({ resolvedPath: '/tmp/addon.nupkg' });
        output.finish();

        assert.deepEqual(infoCalls, []);
        assert.equal(logCalls.length, 1);

        const rendered = JSON.parse(logCalls[0][0]);
        assert.deepEqual(rendered, {
            ok: true,
            command: 'install',
            operation: 'install',
            status: 0,
            data: [{ type: 'install', filename: 'addon.nupkg' }],
            errors: [],
            meta: {
                queued: true,
                resolvedPath: '/tmp/addon.nupkg'
            }
        });
    } finally {
        console.log = originalLog;
        console.info = originalInfo;
    }
});
