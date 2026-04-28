import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCookies, resolveOAuthConfig, shouldUseOAuth } from '../bin/commands/login.js';

test('parseCookies returns an empty object when the header is missing', () => {
    assert.deepEqual(parseCookies(), {});
});

test('parseCookies normalizes the Dynamicweb cookie name and decodes the value', () => {
    const cookies = parseCookies('Dynamicweb.Admin=abc%20123; Path=/');

    assert.equal(cookies.user, 'abc 123');
    assert.equal(cookies.Path, '/');
});

test('shouldUseOAuth honors explicit user auth override', () => {
    assert.equal(shouldUseOAuth({ auth: 'user', oauth: true }, {
        current: { authType: 'oauth_client_credentials' }
    }), false);
});

test('shouldUseOAuth enables oauth from arguments or environment configuration', () => {
    assert.equal(shouldUseOAuth({ oauth: true }), true);
    assert.equal(shouldUseOAuth({}, { current: { authType: 'oauth_client_credentials' } }), true);
    assert.equal(shouldUseOAuth({}, { auth: { type: 'oauth_client_credentials' } }), true);
    assert.equal(shouldUseOAuth({}), false);
});

test('resolveOAuthConfig prefers explicit args over environment variables', () => {
    process.env.TEST_CLI_CLIENT_ID = 'env-client-id';
    process.env.TEST_CLI_CLIENT_SECRET = 'env-client-secret';

    try {
        const config = resolveOAuthConfig({
            clientId: 'arg-client-id',
            clientSecret: 'arg-client-secret',
            clientIdEnv: 'TEST_CLI_CLIENT_ID',
            clientSecretEnv: 'TEST_CLI_CLIENT_SECRET'
        });

        assert.deepEqual(config, {
            clientId: 'arg-client-id',
            clientSecret: 'arg-client-secret',
            clientIdEnv: 'TEST_CLI_CLIENT_ID',
            clientSecretEnv: 'TEST_CLI_CLIENT_SECRET'
        });
    } finally {
        delete process.env.TEST_CLI_CLIENT_ID;
        delete process.env.TEST_CLI_CLIENT_SECRET;
    }
});

test('resolveOAuthConfig falls back to configured env var names', () => {
    process.env.TEST_CLI_CLIENT_ID = 'env-client-id';
    process.env.TEST_CLI_CLIENT_SECRET = 'env-client-secret';

    try {
        const config = resolveOAuthConfig({}, {
            auth: {
                clientIdEnv: 'TEST_CLI_CLIENT_ID',
                clientSecretEnv: 'TEST_CLI_CLIENT_SECRET'
            }
        });

        assert.deepEqual(config, {
            clientId: 'env-client-id',
            clientSecret: 'env-client-secret',
            clientIdEnv: 'TEST_CLI_CLIENT_ID',
            clientSecretEnv: 'TEST_CLI_CLIENT_SECRET'
        });
    } finally {
        delete process.env.TEST_CLI_CLIENT_ID;
        delete process.env.TEST_CLI_CLIENT_SECRET;
    }
});

test('resolveOAuthConfig throws when required credentials are missing', () => {
    assert.throws(
        () => resolveOAuthConfig({ clientIdEnv: 'MISSING_CLIENT_ID', clientSecret: 'secret' }),
        /OAuth client ID not found/
    );

    assert.throws(
        () => resolveOAuthConfig({ clientId: 'client-id', clientSecretEnv: 'MISSING_CLIENT_SECRET' }),
        /OAuth client secret not found/
    );
});
