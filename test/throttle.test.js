import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The transfer state is saved to ~/.dwc: point the home directory at a temp folder
// before any CLI module resolves it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-home-'));
process.env.HOME = process.env.USERPROFILE = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

const { createThrottle, isThrottleResponse, parseRetryAfter, resolveConcurrency, THROTTLE_ATTEMPTS } = await import('../bin/transfer/throttle.js');
const { createFileTransferClient } = await import('../bin/transfer/filetransfer.js');
const { probeFileTransfer, resolveTransfer } = await import('../bin/transfer/index.js');
const { createOutput } = await import('../bin/output.js');
const { setupConfig } = await import('../bin/commands/config.js');
const { startFakeFileTransfer } = await import('./helpers/fake-filetransfer.js');
setupConfig();

const quietOutput = () => createOutput({ command: 'files', operation: 'test', argv: { output: 'json' } });
const iis403 = () => ({ status: 403, text: '<html><body>403 - Forbidden: Access is denied.</body></html>' });
const fastThrottle = (overrides = {}) => createThrottle({ baseDelayMs: 10, pacedIntervalMs: 5, ...overrides });

function tempFiles(t, count) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-throttle-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return Array.from({ length: count }, (_, i) => {
        const file = path.join(dir, `f${i}.txt`);
        fs.writeFileSync(file, `content ${i}`);
        return file;
    });
}

// --- detection and settings -----------------------------------------------------------

test('isThrottleResponse: 429 always, a non-JSON 403 only once the client was accepted', () => {
    assert.equal(isThrottleResponse(429, null, false), true);
    assert.equal(isThrottleResponse(429, { code: 'X' }, false), true);
    assert.equal(isThrottleResponse(403, null, true), true);
    // The first request refused: a static deny, a WAF or rejected credentials look the same.
    assert.equal(isThrottleResponse(403, null, false), false);
    // The API's own refusals, and any JSON 403 (even a bare JSON string), are real errors.
    assert.equal(isThrottleResponse(403, { code: 'FORBIDDEN', message: 'no' }, true), false);
    assert.equal(isThrottleResponse(403, { title: 'Forbidden', status: 403 }, true), false);
    assert.equal(isThrottleResponse(403, 'Forbidden', true), false);
    assert.equal(isThrottleResponse(401, null, true), false);
    assert.equal(isThrottleResponse(503, null, true), false);
});

test('parseRetryAfter: seconds, HTTP dates, garbage, and a cap', () => {
    assert.equal(parseRetryAfter('5'), 5000);
    assert.equal(parseRetryAfter('0'), 0);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(''), null);
    assert.equal(parseRetryAfter('soon'), null);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now), 3000);
    assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), 0);
    assert.equal(parseRetryAfter('86400'), 120_000);
});

test('resolveConcurrency: flag, then DW_TRANSFER_CONCURRENCY, then 4; rejects nonsense', () => {
    assert.equal(resolveConcurrency({}, {}), 4);
    assert.equal(resolveConcurrency({}, { DW_TRANSFER_CONCURRENCY: '2' }), 2);
    assert.equal(resolveConcurrency({ concurrency: 1 }, { DW_TRANSFER_CONCURRENCY: '8' }), 1);
    for (const bad of [0, 17, 1.5, 'abc', -1]) {
        assert.throws(() => resolveConcurrency({ concurrency: bad }, {}), (err) => err.status === 400 && /--concurrency/.test(err.message), String(bad));
    }
    assert.throws(() => resolveConcurrency({}, { DW_TRANSFER_CONCURRENCY: 'x' }), /DW_TRANSFER_CONCURRENCY/);
});

// --- the shared throttle ----------------------------------------------------------------

const respond = (status, body = '', headers = {}) => new Response(body, { status, headers });

test('throttle.send: passes other responses through, reading a 403 body only to classify it', async () => {
    const throttle = fastThrottle();
    assert.deepEqual(Object.keys(await throttle.send(async () => respond(200, 'ok'))), ['res']);
    const forbidden = await throttle.send(async () => respond(403, JSON.stringify({ code: 'FORBIDDEN' })));
    assert.deepEqual(forbidden.body, { code: 'FORBIDDEN' });
});

test('throttle.send: one event per burst, then one paced request at a time', async () => {
    const events = [];
    const throttle = createThrottle({ baseDelayMs: 30, pacedIntervalMs: 10, onThrottle: (e) => events.push(e) });
    let inFlight = 0;
    let maxInFlight = 0;
    const refusedOnce = () => {
        let refused = false;
        return async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(resolve => setTimeout(resolve, 2));
            inFlight--;
            if (refused) return respond(200);
            refused = true;
            return respond(429);
        };
    };

    // Four requests of the same burst come back throttled: one event, not four.
    const started = Date.now();
    await Promise.all([1, 2, 3, 4].map(() => throttle.send(refusedOnce())));
    assert.equal(events.length, 1);
    assert.equal(events[0].requestsPerSecond, 100);
    assert.ok(Date.now() - started >= 25, 'everything waited out the pause');

    // After the event, requests no longer overlap.
    maxInFlight = 0;
    await Promise.all([1, 2, 3].map(() => throttle.send(async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 2)); inFlight--; return respond(200); })));
    assert.equal(maxInFlight, 1);

    // Throttled again after the first event: slower still.
    await throttle.send(refusedOnce());
    assert.equal(events.length, 2);
    assert.equal(events[1].requestsPerSecond, 50);
});

test('throttle.send: a bare 403 is a real error until the server has accepted a request', async () => {
    const throttle = fastThrottle();
    const first = await throttle.send(async () => respond(403, '<html>'));
    assert.equal(first.res.status, 403);
    assert.equal(first.body, null);

    await throttle.send(async () => respond(200));
    let calls = 0;
    const { res } = await throttle.send(async () => ++calls === 1 ? respond(403, '<html>') : respond(200));
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
});

test('throttle.send: Retry-After overrides the computed pause', async () => {
    const throttle = createThrottle({ baseDelayMs: 60_000, pacedIntervalMs: 1 });
    let calls = 0;
    const { res } = await throttle.send(async () => ++calls === 1 ? respond(429, 'slow down', { 'Retry-After': '0' }) : respond(200));
    assert.equal(res.status, 200);
});

test('throttle.send: gives up with RATE_LIMITED after THROTTLE_ATTEMPTS', async () => {
    let calls = 0;
    const throttle = fastThrottle();
    await assert.rejects(throttle.send(async () => { calls++; return respond(429); }), (err) => err.status === 429 && err.details.code === 'RATE_LIMITED');
    assert.equal(calls, THROTTLE_ATTEMPTS);

    // Later requests (such as cleanup) fail at once instead of waiting out more pauses.
    await assert.rejects(throttle.send(async () => { calls++; return respond(200); }), (err) => err.details.code === 'RATE_LIMITED');
    assert.equal(calls, THROTTLE_ATTEMPTS);
});

// --- the client against a fake File Transfer API ------------------------------------------

test('upload: an IIS-style 403 pauses, slows down, and the upload completes', async (t) => {
    const fake = await startFakeFileTransfer(t, { faults: { 'PUT uploads/:id/chunks/:n': [iis403(), iis403(), iis403()] } });
    const events = [];
    const throttle = fastThrottle({ onThrottle: (e) => events.push(e) });
    const client = createFileTransferClient(fake.env, { apiKey: 'k' }, { throttle });
    const files = tempFiles(t, 8);
    const output = quietOutput();

    await client.uploadFiles(files, 'Docs', {}, output);

    assert.equal(output.response.data[0].files.length, 8);
    for (let i = 0; i < 8; i++) assert.equal(fake.store.get(`Docs/f${i}.txt`).toString(), `content ${i}`);
    assert.ok(events.length >= 1);
});

test('upload: a 429 with Retry-After from the platform rate limiter is retried', async (t) => {
    const fake = await startFakeFileTransfer(t, { faults: { 'POST uploads': [{ status: 429, text: 'Too many requests', headers: { 'Retry-After': '0' } }] } });
    const client = createFileTransferClient(fake.env, { apiKey: 'k' }, { throttle: fastThrottle({ baseDelayMs: 60_000 }) });
    const [file] = tempFiles(t, 1);

    await client.uploadFiles([file], 'Docs', {}, quietOutput());

    assert.equal(fake.store.get('Docs/f0.txt').toString(), 'content 0');
    assert.equal(fake.requests.filter(r => r.key === 'POST uploads').length, 2);
});

test('upload: throttled retries do not use up the attempts for transient errors', async (t) => {
    // Three 503s alone would exhaust the 4 normal attempts if throttling counted too.
    const fake = await startFakeFileTransfer(t, { faults: { 'POST uploads': [503, iis403(), 503, iis403(), 503] } });
    const client = createFileTransferClient(fake.env, { apiKey: 'k' }, { throttle: fastThrottle() });
    const [file] = tempFiles(t, 1);

    await client.uploadFiles([file], 'Docs', {}, quietOutput());

    assert.ok(fake.store.has('Docs/f0.txt'));
});

test('upload: a server that never stops throttling fails with RATE_LIMITED and advice', async (t) => {
    const fake = await startFakeFileTransfer(t, { faults: { 'POST uploads': Array.from({ length: THROTTLE_ATTEMPTS }, iis403) } });
    const client = createFileTransferClient(fake.env, { apiKey: 'k' }, { throttle: fastThrottle() });
    const [file] = tempFiles(t, 1);

    await assert.rejects(client.uploadFiles([file], 'Docs', {}, quietOutput()), (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.details.code, 'RATE_LIMITED');
        // The command's message stays generic; the reason printed under it explains.
        assert.match(err.details.message, /rate limit or firewall/);
        assert.match(err.details.message, /--concurrency 1/);
        return true;
    });
    assert.equal(fake.requests.filter(r => r.key === 'POST uploads').length, THROTTLE_ATTEMPTS);
});

test('upload: the API\'s own FORBIDDEN is not mistaken for throttling', async (t) => {
    const fake = await startFakeFileTransfer(t, { faults: { 'POST uploads': [{ status: 403, text: JSON.stringify({ code: 'FORBIDDEN', message: 'Create permission is required.', path: 'Docs' }), headers: { 'Content-Type': 'application/json' } }] } });
    const events = [];
    const client = createFileTransferClient(fake.env, { apiKey: 'k' }, { throttle: fastThrottle({ onThrottle: (e) => events.push(e) }) });
    const [file] = tempFiles(t, 1);

    await assert.rejects(client.uploadFiles([file], 'Docs', {}, quietOutput()), (err) => err.details?.code === 'FORBIDDEN');
    assert.equal(events.length, 0);
    assert.equal(fake.requests.filter(r => r.key === 'POST uploads').length, 1);
});

// --- probe and resolution -----------------------------------------------------------------

const status429 = () => ({ status: 429, text: 'Too many requests' });

test('probe: a rate-limited check (429) is retried', async (t) => {
    const fake = await startFakeFileTransfer(t, { faults: { 'GET entries/exists': [status429()] } });
    assert.equal(await probeFileTransfer(fake.env, { apiKey: 'k' }, fastThrottle()), true);
});

test('probe: a bare 403 fails at once and names both credentials and a firewall or rate limit', async (t) => {
    const fake = await startFakeFileTransfer(t, { faults: { 'GET entries/exists': [iis403()] } });
    await assert.rejects(probeFileTransfer(fake.env, { apiKey: 'k' }, fastThrottle()),
        (err) => err.status === 403 && /API key or token may be rejected/.test(err.message) && /rate limit/.test(err.message));
    assert.equal(fake.requests.length, 1);
});

test('resolveTransfer: the probe shares the throttle, and the JSON envelope stays as with legacy', async (t) => {
    const fake = await startFakeFileTransfer(t, { faults: { 'GET entries/exists': [status429()] } });
    const output = quietOutput();
    const transfer = await resolveTransfer({ concurrency: 3 }, fake.env, { apiKey: 'k' }, output, { throttleOptions: { baseDelayMs: 10, pacedIntervalMs: 5 } });

    assert.equal(transfer.name, 'filetransfer');
    assert.deepEqual(output.response.meta, { transfer: 'filetransfer', transferSource: 'default' });
});

test('resolveTransfer: an invalid concurrency does not break the legacy transfer', async () => {
    const env = { protocol: 'http', host: 'x' };
    const transfer = await resolveTransfer({ transfer: 'legacy', concurrency: 99 }, env, { apiKey: 'k' }, quietOutput());
    assert.equal(transfer.name, 'legacy');
    await assert.rejects(resolveTransfer({ concurrency: 99 }, env, { apiKey: 'k' }, quietOutput(), { probe: async () => true }), /Invalid concurrency/);
});

test('resolveTransfer: --concurrency sets how many files move at once', async () => {
    const transfer = await resolveTransfer({ transfer: 'filetransfer', concurrency: 2 }, { protocol: 'http', host: 'x' }, { apiKey: 'k' }, quietOutput(), { probe: async () => true });
    assert.equal(transfer.client.concurrency, 2);
});
