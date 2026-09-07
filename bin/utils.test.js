import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOptionName, isRemoteParam, redactUrl } from './utils.js';

test('normalizeOptionName folds every spelling of an option onto one name', () => {
    assert.equal(normalizeOptionName('apiKey'), 'apikey');
    assert.equal(normalizeOptionName('api-key'), 'apikey');
    assert.equal(normalizeOptionName('API_KEY'), 'apikey');
});

test('isRemoteParam rejects a reserved switch under any spelling', () => {
    const isParam = isRemoteParam(['apiKey', 'host', 'verbose']);

    // yargs puts both spellings of a camelCase option into argv; excluding only the
    // literal name let api-key through and into the request URL.
    assert.equal(isParam('apiKey'), false);
    assert.equal(isParam('api-key'), false);
    assert.equal(isParam('host'), false);
});

test('isRemoteParam keeps genuine query parameters', () => {
    const isParam = isRemoteParam(['apiKey', 'host']);

    assert.equal(isParam('Query'), true);
    assert.equal(isParam('PageSize'), true);
});

test('redactUrl masks credentials but leaves the rest of the URL readable', () => {
    const redacted = redactUrl('https://example.dynamicweb.cloud/Admin/Api/Foo?Query=SELECT+1&api-key=Test.24d6secret');

    assert.ok(!redacted.includes('Test.24d6secret'));
    assert.ok(redacted.includes('api-key=***'));
    assert.ok(redacted.includes('Query=SELECT+1'));
});

test('redactUrl masks every spelling of a credential parameter', () => {
    for (const name of ['apiKey', 'api-key', 'token', 'password', 'secret']) {
        const redacted = redactUrl(`https://example.com/x?${name}=hunter2`);
        assert.ok(!redacted.includes('hunter2'), `${name} was not redacted`);
    }
});

test('redactUrl still masks when the input is not a parsable URL', () => {
    const redacted = redactUrl('not a url?api-key=hunter2&x=1');

    assert.ok(!redacted.includes('hunter2'));
});

test('redactUrl passes through a URL with nothing sensitive in it', () => {
    const url = 'https://example.com/Admin/Api/Foo?Query=SELECT+1';

    assert.equal(redactUrl(url), url);
});
