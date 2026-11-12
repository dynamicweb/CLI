import { createCommandError } from '../commands/env.js';

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export const CONCURRENCY_ENV_VAR = 'DW_TRANSFER_CONCURRENCY';

/** Requests a throttled request is sent in total before the CLI gives up. */
export const THROTTLE_ATTEMPTS = 6;
/** Pacing after the first throttle: 5 requests a second, halved on every further one. */
const PACED_INTERVAL_MS = 200;
const MAX_PACED_INTERVAL_MS = 2000;
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Whether a response means "slow down" rather than a real error: HTTP 429, or an HTTP 403
 * that is not JSON (`body` is the parsed body, null when it was empty or not JSON) once
 * the server has accepted this client before.
 *
 * Dynamicweb answers its own 403s with JSON. An empty or HTML 403 comes from something in
 * front of the solution: IIS Dynamic IP Restrictions (403.502 when the request rate is
 * exceeded, 403.501 for too many concurrent requests), but just as well a static IP deny,
 * a WAF or rejected credentials. Those refuse the first request already, so a bare 403
 * only counts as throttling after an earlier request got through (`accepted`).
 */
export function isThrottleResponse(status, body, accepted) {
    return status === 429 || (status === 403 && body === null && accepted === true);
}

/**
 * Parses a Retry-After header (seconds or an HTTP date) into milliseconds, capped so a
 * misconfigured server cannot park the CLI for hours. Null when absent or unreadable.
 */
export function parseRetryAfter(value, now = Date.now()) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const ms = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
    return Number.isNaN(ms) ? null : Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** The parsed JSON body of a response, or null when it is empty or not JSON. */
export async function parseJsonSafe(res) {
    try {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

/**
 * The number of files a File Transfer client moves at once: `--concurrency`, then
 * DW_TRANSFER_CONCURRENCY, then the default.
 */
export function resolveConcurrency(argv = {}, environment = process.env) {
    const candidates = [['--concurrency', argv.concurrency], [CONCURRENCY_ENV_VAR, environment[CONCURRENCY_ENV_VAR]]];
    for (const [origin, value] of candidates) {
        if (value === undefined || value === null || value === '') continue;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
            throw createCommandError(`Invalid concurrency "${value}" in ${origin}. Use a whole number from 1 to ${MAX_CONCURRENCY}.`, 400);
        }
        return n;
    }
    return DEFAULT_CONCURRENCY;
}

/**
 * Shared back-off for every request one client sends. When the server (or a proxy in
 * front of it) throttles a request, all requests pause together -- workers that kept
 * sending would keep the client's IP blocked -- and afterwards the client sends one
 * request at a time, paced, for the rest of the command.
 *
 * Responses to requests sent before the latest throttle began are part of the same
 * event: they extend the pause but do not slow the client down further.
 *
 * @param {Object} [options]
 * @param {number} [options.concurrency] - Files a client moves at once (its worker count).
 * @param {number} [options.baseDelayMs] - Pause without Retry-After; grows per attempt.
 * @param {number} [options.pacedIntervalMs] - Gap between requests after the first throttle.
 * @param {(event: {waitMs: number, requestsPerSecond: number, events: number}) => void} [options.onThrottle]
 */
export function createThrottle({ concurrency = DEFAULT_CONCURRENCY, baseDelayMs = 6000, pacedIntervalMs = PACED_INTERVAL_MS, onThrottle } = {}) {
    let pausedUntil = 0;
    let nextSlot = 0;
    let interval = 0; // 0 until throttled; then requests go one at a time, this far apart
    let events = 0;
    let active = 0;
    let accepted = false; // a request got past whatever sends bare 403s
    let gaveUp = false;
    const waiting = [];

    /** Waits until a request may be sent; returns the throttle event it is sent in. */
    async function acquire() {
        for (;;) {
            while (interval && active >= 1) await new Promise(resolve => waiting.push(resolve));
            const wait = Math.max(pausedUntil, nextSlot) - Date.now();
            if (wait > 0) {
                await sleep(wait);
                continue;
            }
            active++;
            if (interval) nextSlot = Date.now() + interval;
            return events;
        }
    }

    function release() {
        active--;
        waiting.shift()?.();
    }

    /**
     * Pauses everything for Retry-After, or a pause that grows with the attempt (with
     * jitter, so separate CLI runs do not line up), and slows down on a new event.
     */
    function pause(sentIn, attempt, retryAfterMs) {
        const waitMs = retryAfterMs ?? Math.round(baseDelayMs * attempt * (1 + Math.random() * 0.25));
        pausedUntil = Math.max(pausedUntil, Date.now() + waitMs);
        if (sentIn === events) {
            events++;
            interval = interval ? Math.min(interval * 2, MAX_PACED_INTERVAL_MS) : pacedIntervalMs;
            onThrottle?.({ waitMs, requestsPerSecond: Math.round(10000 / interval) / 10, events });
        }
    }

    return {
        concurrency,

        /**
         * Sends a request through the throttle, retrying it while it is throttled, up to
         * THROTTLE_ATTEMPTS times. Once a request has given up, every later one fails at
         * once: the command is failing, and cleanup should not wait out more pauses.
         *
         * @param {() => Promise<Response>} sendOnce
         * @returns {Promise<{ res: Response, body?: * }>} `body` is the parsed body of an
         *   error response (null when not JSON); a successful one is left unread.
         */
        async send(sendOnce) {
            for (let attempt = 1; ; attempt++) {
                if (gaveUp) throw createRateLimitError(gaveUp.status, null, gaveUp.url);
                const sentIn = await acquire();
                let res;
                try {
                    res = await sendOnce();
                } finally {
                    release();
                }
                if (res.ok) {
                    accepted = true;
                    return { res };
                }
                const body = await parseJsonSafe(res);
                if (!isThrottleResponse(res.status, body, accepted)) {
                    accepted ||= res.status !== 403 && res.status !== 429;
                    return { res, body };
                }
                if (attempt >= THROTTLE_ATTEMPTS) {
                    gaveUp = { status: res.status, url: res.url };
                    throw createRateLimitError(res.status, body, res.url);
                }
                pause(sentIn, attempt, parseRetryAfter(res.headers.get('retry-after')));
            }
        }
    };
}

/** The error for a request that stayed throttled through every attempt. */
export function createRateLimitError(status, body, url) {
    const message = status === 429
        ? 'The server kept rate-limiting requests (HTTP 429) and the CLI gave up after backing off.'
        : 'The server kept refusing requests with HTTP 403 without a Dynamicweb error. This is usually a rate limit or firewall in front of the solution, such as IIS Dynamic IP Restrictions (403.502).';
    return createCommandError(message, status, {
        code: 'RATE_LIMITED',
        message: `${message} Retry with --concurrency 1, use --transfer legacy (fewer requests), or ask the host to raise the limit or exempt /Admin/.`,
        status,
        url,
        ...(body && typeof body === 'object' ? { response: body } : {})
    });
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
