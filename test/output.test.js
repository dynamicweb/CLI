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

test('createOutput reports a File Transfer API refusal as a permission error', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'files', operation: 'import', argv: { output: 'json' } });
    const details = { code: 'FORBIDDEN', message: 'Write permission is required on the path.', path: 'QA/CLI' };

    output.fail(createCommandError('File upload failed.', 403, details));
    output.finish();

    const response = JSON.parse(calls.log[0]);
    assert.equal(response.status, 403);
    assert.deepEqual(response.errors, [{ message: 'File upload failed.', details, code: 'PERMISSION_DENIED', path: 'QA/CLI' }]);
});

test('createOutput reports a legacy refusal like the File Transfer API, despite its HTTP 401', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'files', operation: 'export', argv: { output: 'json' } });
    const details = { status: 'notAllowed', message: 'You do not have permission to access this directory' };

    output.fail(createCommandError('Failed to download "templates".', 401, details));
    output.finish();

    const response = JSON.parse(calls.log[0]);
    assert.equal(response.status, 403);
    assert.deepEqual(response.errors, [{ message: 'Failed to download "templates".', details, code: 'PERMISSION_DENIED' }]);
});

test('createOutput explains a permission error in human mode without repeating the server message', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'files', operation: 'export', argv: {} });
    const message = 'Read permission is required on the path.';

    output.fail(createCommandError(message, 403, { code: 'FORBIDDEN', message, path: '' }));
    output.finish();

    assert.deepEqual(calls.error, [
        'Error: Permission denied on "/".',
        `  ${message}`,
        '  The user behind the API key or OAuth client has no permission on "/". Grant it in Dynamicweb, or use a path it can access.'
    ]);
});

test('createOutput leaves other 401 and 403 errors alone', (t) => {
    const calls = capture(t);
    const output = createOutput({ command: 'files', operation: 'list', argv: { output: 'json' } });

    output.fail(createCommandError('Authentication failed.', 401, { message: 'Unauthorized' }));
    output.finish();

    const response = JSON.parse(calls.log[0]);
    assert.equal(response.status, 401);
    assert.equal(response.errors[0].code, undefined);
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
