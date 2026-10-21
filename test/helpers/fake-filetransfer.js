import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * In-memory stand-in for the File Transfer API, faithful to the parts of its contract the
 * CLI relies on: eTags change with content, If-Match/If-Range are honoured, moves and
 * copies take exact destination paths, uploads go through chunked sessions.
 *
 * `faults` injects failures by "METHOD route" key (session ids replaced by `:id`), each
 * entry a list of statuses consumed one per request; status 0 drops the connection after
 * sending part of a download.
 */
export async function startFakeFileTransfer(t, { files = {}, directories = [], faults = {}, chunkSize = 4, manifestPageSize = 2 } = {}) {
    const store = new Map(Object.entries(files).map(([p, data]) => [p, Buffer.from(data)]));
    const mtimes = new Map();
    const explicitDirs = new Set(directories);
    const sessions = new Map();
    const requests = [];
    let clock = 1000;

    const touch = (p) => mtimes.set(p, ++clock);
    for (const p of store.keys()) touch(p);
    const eTagOf = (p) => `"${store.get(p).length.toString(16)}-${(mtimes.get(p) ?? 0).toString(16)}"`;
    const allDirs = () => {
        const dirs = new Set(explicitDirs);
        for (const p of store.keys()) {
            const parts = p.split('/');
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        return dirs;
    };
    const isDir = (p) => p === '' || allDirs().has(p);
    const entryFor = (p) => store.has(p)
        ? { path: p, name: path.posix.basename(p), isDirectory: false, size: store.get(p).length, modifiedUtc: new Date(mtimes.get(p)).toISOString(), eTag: eTagOf(p) }
        : { path: p, name: path.posix.basename(p), isDirectory: true, size: 0, modifiedUtc: new Date(0).toISOString(), eTag: null };
    const under = (prefix, p) => prefix === '' || p === prefix || p.startsWith(`${prefix}/`);
    const write = (p, data) => {
        store.set(p, data);
        touch(p);
    };
    const ifMatchFails = (header, p) => header && header !== '*' && (!store.has(p) || header !== eTagOf(p));

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const route = url.pathname.replace('/Admin/Api/FileTransfer/', '');
        const body = await new Promise((resolve) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
        const key = `${req.method} ${route.replace(/^uploads\/[^/]+/, 'uploads/:id').replace(/chunks\/\d+$/, 'chunks/:n')}`;
        requests.push({ key, idempotencyKey: req.headers['idempotency-key'], headers: req.headers, query: Object.fromEntries(url.searchParams) });
        const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const fail = (status, code, message, extra = {}) => send(status, { code, message, retryable: false, ...extra });

        const fault = faults[key]?.shift();
        if (fault) return send(fault, { code: 'IO_ERROR', message: 'transient', retryable: true });

        const json = body.length && req.headers['content-type']?.includes('json') ? JSON.parse(body) : {};
        const q = (name) => (url.searchParams.get(name) ?? '').replace(/^\/+|\/+$/g, '');

        switch (key) {
            case 'GET entries/exists': {
                const p = q('path');
                return send(200, { path: p, exists: store.has(p) || isDir(p), isDirectory: isDir(p) });
            }
            case 'GET entries/metadata': {
                const p = q('path');
                if (!store.has(p) && !isDir(p)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.');
                return send(200, entryFor(p));
            }
            case 'GET entries/checksum': {
                const p = q('path');
                if (!store.has(p)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.');
                return send(200, { path: p, algorithm: 'sha256', value: sha256(store.get(p)), size: store.get(p).length, eTag: eTagOf(p) });
            }
            case 'GET entries/usage': {
                const p = q('path');
                if (!isDir(p)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.');
                const inside = [...store.keys()].filter(f => under(p, f) && f !== p);
                return send(200, { path: p, totalBytes: inside.reduce((n, f) => n + store.get(f).length, 0), fileCount: inside.length, directoryCount: [...allDirs()].filter(d => d !== p && under(p, d)).length });
            }
            case 'GET entries': {
                const p = q('path');
                if (!isDir(p)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.');
                const prefix = p ? `${p}/` : '';
                const children = new Set([...store.keys(), ...allDirs()].filter(x => x.startsWith(prefix) && x !== p).map(x => prefix + x.slice(prefix.length).split('/')[0]));
                return send(200, [...children].sort().map(entryFor));
            }
            case 'GET manifest': {
                const p = q('path');
                if (!isDir(p)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.');
                const prefix = p ? `${p}/` : '';
                const all = [...new Set([...allDirs(), ...store.keys()])].filter(x => x.startsWith(prefix) && x !== p).sort()
                    .map(x => ({ ...entryFor(x), path: x.slice(prefix.length) }));
                const start = Number(url.searchParams.get('cursor') ?? 0);
                return send(200, { path: p, entries: all.slice(start, start + manifestPageSize), nextCursor: start + manifestPageSize < all.length ? String(start + manifestPageSize) : null });
            }
            case 'GET entries/download': {
                const p = q('path');
                if (!store.has(p)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.');
                const data = store.get(p);
                const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
                const ifRange = req.headers['if-range'];
                if (range && (!ifRange || ifRange === eTagOf(p))) {
                    const start = Number(range[1]);
                    if (start >= data.length) { res.writeHead(416); return res.end(); }
                    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'ETag': eTagOf(p) });
                    return res.end(data.subarray(start));
                }
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'ETag': eTagOf(p), 'Content-Length': data.length });
                if (faults[`CORRUPT ${p}`]?.shift()) {
                    const corrupted = Buffer.from(data);
                    corrupted[0] ^= 0xff;
                    return res.end(corrupted);
                }
                if (faults[`DROP ${p}`]?.shift()) {
                    res.write(data.subarray(0, Math.ceil(data.length / 2)));
                    return setTimeout(() => res.socket.destroy(), 20);
                }
                return res.end(data);
            }
            case 'POST entries/directory': {
                const p = json.path.replace(/^\/+/, '');
                if (store.has(p)) return fail(409, 'ALREADY_EXISTS', 'A file already exists at the path.');
                const created = !isDir(p);
                explicitDirs.add(p);
                return send(200, { entry: entryFor(p), created });
            }
            case 'POST entries/delete': {
                const p = json.path.replace(/^\/+/, '');
                if (!store.has(p) && !isDir(p)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.', { path: p });
                if (store.has(p)) {
                    if (ifMatchFails(req.headers['if-match'], p)) return fail(412, 'PRECONDITION_FAILED', 'The entity tag does not match the current version of the file.', { path: p });
                    store.delete(p);
                } else {
                    for (const f of [...store.keys()]) if (under(p, f)) store.delete(f);
                    for (const d of [...explicitDirs]) if (under(p, d)) explicitDirs.delete(d);
                }
                return send(200, { path: p, exists: false, isDirectory: false });
            }
            case 'POST entries/move':
            case 'POST entries/copy': {
                const source = json.sourcePath.replace(/^\/+/, '');
                const destination = json.destinationPath.replace(/^\/+/, '');
                if (!store.has(source) && !isDir(source)) return fail(404, 'NOT_FOUND', 'No file or directory exists at the path.', { path: source });
                if (ifMatchFails(req.headers['if-match'], destination)) return fail(412, 'PRECONDITION_FAILED', 'The entity tag does not match.', { path: destination });
                if (isDir(destination)) return fail(409, 'ALREADY_EXISTS', 'A directory already exists at the destination.', { path: destination });
                if (store.has(destination) && !json.overwrite && !req.headers['if-match']) return fail(409, 'ALREADY_EXISTS', 'A file already exists at the destination.', { path: destination });
                const moves = store.has(source) ? [[source, destination]]
                    : [...store.keys()].filter(f => under(source, f)).map(f => [f, destination + f.slice(source.length)]);
                for (const [from, to] of moves) {
                    store.set(to, store.get(from));
                    mtimes.set(to, mtimes.get(from)); // a rename or copy keeps the modification time
                    if (key === 'POST entries/move') { store.delete(from); mtimes.delete(from); }
                }
                if (!store.has(source) && key === 'POST entries/move') {
                    for (const d of [...explicitDirs]) if (under(source, d)) { explicitDirs.delete(d); explicitDirs.add(destination + d.slice(source.length)); }
                }
                explicitDirs.add(path.posix.dirname(destination));
                return send(200, entryFor(destination));
            }
            case 'POST uploads': {
                const id = `s${sessions.size + 1}-${Date.now()}`;
                const session = { id, targetPath: json.targetPath.replace(/^\/+/, ''), fileSize: json.fileSize, chunkSize, totalChunks: Math.ceil(json.fileSize / chunkSize), chunks: [] };
                sessions.set(id, session);
                return send(201, session);
            }
            case 'PUT uploads/:id/chunks/:n': {
                const [, id, , index] = route.split('/');
                if (req.headers['x-content-sha256'] && req.headers['x-content-sha256'] !== sha256(body)) return fail(422, 'CHECKSUM_MISMATCH', 'bad chunk');
                sessions.get(id).chunks[Number(index)] = body;
                return send(200, { received: true });
            }
            case 'POST uploads/:id/finalize': {
                const session = sessions.get(route.split('/')[1]);
                const data = Buffer.concat(session.chunks.filter(Boolean));
                if (sha256(data) !== json.sha256) return fail(422, 'CHECKSUM_MISMATCH', 'bad file');
                const target = session.targetPath;
                if (ifMatchFails(req.headers['if-match'], target)) return fail(412, 'PRECONDITION_FAILED', 'The entity tag does not match.', { path: target });
                if (store.has(target) && !json.overwrite && !req.headers['if-match']) return fail(409, 'ALREADY_EXISTS', 'A file already exists at the target path.', { path: target });
                write(target, data);
                sessions.delete(session.id);
                return send(200, { targetPath: target, size: data.length, sha256: json.sha256, eTag: eTagOf(target), completedUtc: new Date().toISOString() });
            }
            case 'DELETE uploads/:id':
                sessions.delete(route.split('/')[1]);
                return send(200, {});
            default:
                return fail(404, 'NOT_FOUND', `no route ${key}`);
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return {
        env: { protocol: 'http', host: `127.0.0.1:${server.address().port}` },
        store,
        sessions,
        requests,
        explicitDirs,
        eTagOf,
        /** Changes a file the way an editor on the server would. */
        edit: (p, data) => write(p, Buffer.from(data))
    };
}
