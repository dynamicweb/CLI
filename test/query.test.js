import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildInteractiveQueryParams,
    buildQueryParamsFromArgv,
    extractQueryPropertyPrompts,
    getFieldNameFromPropertyPrompt,
    getQueryParams
} from '../bin/commands/query.js';

test('extractQueryPropertyPrompts maps properties fields to prompt labels', () => {
    const prompts = extractQueryPropertyPrompts({
        model: {
            properties: {
                groups: [
                    {
                        name: 'Properties',
                        fields: [
                            { name: 'id', typeName: 'System.Int32' },
                            { name: 'culture', typeName: 'System.String' }
                        ]
                    }
                ]
            }
        }
    });

    assert.deepEqual(prompts, [
        'id (System.Int32)',
        'culture (System.String)'
    ]);
});

test('extractQueryPropertyPrompts returns an empty list when the Properties group is missing', () => {
    const prompts = extractQueryPropertyPrompts({
        model: {
            properties: {
                groups: [
                    {
                        name: 'Other',
                        fields: [
                            { name: 'ignored', typeName: 'System.String' }
                        ]
                    }
                ]
            }
        }
    });

    assert.deepEqual(prompts, []);
});

test('getFieldNameFromPropertyPrompt removes only the trailing type suffix', () => {
    assert.equal(getFieldNameFromPropertyPrompt('id (System.Int32)'), 'id');
    assert.equal(getFieldNameFromPropertyPrompt('Category (Primary) (System.String)'), 'Category (Primary)');
    assert.equal(getFieldNameFromPropertyPrompt('plainField'), 'plainField');
});

test('buildInteractiveQueryParams maps prompt answers back to field names and skips empty values', async () => {
    const prompts = [
        'id (System.Int32)',
        'Category (Primary) (System.String)',
        'culture (System.String)'
    ];
    const answers = ['42', 'news', ''];
    const seenMessages = [];

    const params = await buildInteractiveQueryParams(prompts, async ({ message }) => {
        seenMessages.push(message);
        return answers.shift();
    });

    assert.deepEqual(seenMessages, prompts);
    assert.deepEqual(params, {
        id: '42',
        'Category (Primary)': 'news'
    });
});

test('buildQueryParamsFromArgv keeps only query-specific arguments', () => {
    const params = buildQueryParamsFromArgv({
        query: 'GetItems',
        host: 'example.com',
        protocol: 'https',
        interactive: true,
        output: 'json',
        id: 123,
        culture: 'en-US'
    });

    assert.deepEqual(params, {
        id: 123,
        culture: 'en-US'
    });
});

test('getQueryParams uses filtered argv params in non-interactive mode', async () => {
    const params = await getQueryParams(null, null, {
        query: 'GetItems',
        host: 'example.com',
        id: 99,
        pageSize: 10
    }, {
        log() {}
    });

    assert.deepEqual(params, {
        id: 99,
        pageSize: 10
    });
});

test('getQueryParams uses property prompts and prompt answers in interactive mode', async () => {
    const outputCalls = [];

    const params = await getQueryParams(null, null, {
        query: 'GetItems',
        interactive: true
    }, {
        log(value) {
            outputCalls.push(value);
        }
    }, {
        getPropertiesFn: async () => [
            'id (System.Int32)',
            'culture (System.String)'
        ],
        promptFn: async ({ message }) => message === 'id (System.Int32)' ? '77' : 'da-DK'
    });

    assert.deepEqual(params, {
        id: '77',
        culture: 'da-DK'
    });
    assert.deepEqual(outputCalls, [
        'The following properties will be requested:',
        ['id (System.Int32)', 'culture (System.String)']
    ]);
});
