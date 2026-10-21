import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutput, describeDetails } from '../bin/output.js';
import { createCommandError } from '../bin/commands/env.js';

function capture(t) {
    const calls = { log: [], info: [], error: [] };
    for (const method of Object.keys(calls)) {
        t.mock.method(console, method, (...args) => calls[method].push(args.join(' ')));
    }
    return calls;
}

test('createOutput prints only the envelope in json mode, including failures', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'files', operation: 'import', argv: { output: 'json', verbose: true }, meta: { a: 1 } });

    output.log('hidden');
    output.verboseLog('hidden');
    output.fail(createCommandError('File upload failed.', 401, { message: 'Unauthorized' }));
    output.finish();

    assert.deepEqual(calls.info, []);
    assert.deepEqual(calls.error, []);
    assert.equal(calls.log.length, 1);
    assert.deepEqual(JSON.parse(calls.log[0]), {
        ok: false,
        command: 'files',
        operation: 'import',
        status: 401,
        data: [],
        errors: [{ message: 'File upload failed.', details: { message: 'Unauthorized' } }],
        meta: { a: 1 }
    });
});

test('createOutput reports failures on stderr in human mode', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'files', operation: 'list', argv: {} });

    output.log('working');
    output.fail(createCommandError('Unable to fetch file structure.', 404, { message: 'Not found' }));
    output.finish();

    assert.deepEqual(calls.log, ['working']);
    assert.deepEqual(calls.error, ['Error: Unable to fetch file structure.', '  Not found']);
});

test('describeDetails extracts the API message or validation errors', () => {
    assert.equal(describeDetails({ status: 'error', message: 'A directory with the same name already exists' }), 'A directory with the same name already exists');
    assert.equal(describeDetails({ '': ['Command validation failed'], Name: ['The value is required.'] }), 'Command validation failed; Name: The value is required.');
    assert.equal(describeDetails({ status: 'notFound', message: null }), null);
    assert.equal(describeDetails(null), null);
    assert.equal(describeDetails('plain text'), null);
});

test('createOutput adds error details in verbose human mode', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'query', operation: 'run', argv: { verbose: true } });

    output.fail(createCommandError('Error when doing request', 500, { message: 'Boom' }));
    output.finish();

    assert.equal(calls.error[0], 'Error: Error when doing request');
    assert.match(calls.error[1], /"message": "Boom"/);
});

test('createOutput prints nothing extra on success in human mode', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'env', operation: 'list', argv: {} });

    output.addData({ environments: [] });
    output.finish();

    assert.deepEqual(calls.log, []);
    assert.deepEqual(calls.error, []);
    assert.equal(output.response.ok, true);
    assert.equal(output.response.status, 0);
});
