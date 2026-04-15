import test from 'node:test';
import assert from 'node:assert/strict';

import { setConfigForTests } from '../bin/commands/config.js';
import { parseHostInput, setupEnv } from '../bin/commands/env.js';

test.afterEach(() => {
    setConfigForTests({});
});

test('parseHostInput defaults to https when no protocol is provided', () => {
    assert.deepEqual(parseHostInput('example.com'), {
        protocol: 'https',
        host: 'example.com'
    });
});

test('parseHostInput preserves an explicit protocol', () => {
    assert.deepEqual(parseHostInput('http://example.com'), {
        protocol: 'http',
        host: 'example.com'
    });
});

test('parseHostInput rejects malformed host values with multiple protocol separators', () => {
    assert.throws(
        () => parseHostInput('https://example.com://admin'),
        /Issues resolving host/
    );
});

test('setupEnv prefers direct host arguments and defaults protocol to https', async () => {
    setConfigForTests({
        env: {
            saved: {
                host: 'saved.example.com',
                protocol: 'http'
            }
        },
        current: {
            env: 'saved'
        }
    });

    const env = await setupEnv({
        host: 'override.example.com'
    });

    assert.deepEqual(env, {
        host: 'override.example.com',
        protocol: 'https'
    });
});

test('setupEnv uses the explicit protocol when provided with a host override', async () => {
    const env = await setupEnv({
        host: 'override.example.com',
        protocol: 'http'
    });

    assert.deepEqual(env, {
        host: 'override.example.com',
        protocol: 'http'
    });
});

test('setupEnv resolves the requested environment from config', async () => {
    setConfigForTests({
        env: {
            dev: {
                host: 'dev.example.com',
                protocol: 'https'
            },
            prod: {
                host: 'prod.example.com',
                protocol: 'http'
            }
        },
        current: {
            env: 'dev'
        }
    });

    const env = await setupEnv({
        env: 'prod'
    });

    assert.deepEqual(env, {
        host: 'prod.example.com',
        protocol: 'http'
    });
});

test('setupEnv falls back to the current environment and defaults a missing protocol', async () => {
    const originalLog = console.log;
    const logCalls = [];
    console.log = (...args) => {
        logCalls.push(args);
    };

    setConfigForTests({
        env: {
            dev: {
                host: 'dev.example.com'
            }
        },
        current: {
            env: 'dev'
        }
    });

    try {
        const env = await setupEnv({});

        assert.deepEqual(env, {
            host: 'dev.example.com',
            protocol: 'https'
        });
        assert.equal(logCalls.length, 1);
        assert.match(String(logCalls[0][0]), /Protocol for environment not set, defaulting to https/);
    } finally {
        console.log = originalLog;
    }
});

test('setupEnv throws in json mode when no environment is configured', async () => {
    setConfigForTests({});

    await assert.rejects(
        setupEnv({
            output: 'json'
        }),
        /Current environment not set, please set it/
    );
});

test('setupEnv uses the interactive fallback when no environment is configured', async () => {
    setConfigForTests({});
    const calls = [];
    const originalLog = console.log;
    console.log = () => {};

    try {
        const env = await setupEnv({}, null, {
            interactiveEnvFn: async (argv, options) => {
                calls.push({ argv, options });
                setConfigForTests({
                    env: {
                        qa: {
                            host: 'qa.example.com',
                            protocol: 'https'
                        }
                    },
                    current: {
                        env: 'qa'
                    }
                });
            }
        });

        assert.deepEqual(env, {
            host: 'qa.example.com',
            protocol: 'https'
        });
        assert.equal(calls.length, 1);
        assert.deepEqual(Object.keys(calls[0].options), ['environment', 'interactive']);
    } finally {
        console.log = originalLog;
    }
});
