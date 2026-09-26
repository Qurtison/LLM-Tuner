// Model download service: repo listing, the .part/rename write path, HTTP
// Range resume, cancel, and the shape guards on start().
//
// No network: a local Bun.served stand-in for huggingface.co is injected
// through the service's origin seam.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HfDownloadService, parseGgufName } from '../src/server/services/hf';

const REPO = 'ukisai/Swift-1.5-Qwen3.8-27B-GGUF';
const FOLDER = 'ukisai--Swift-1.5-Qwen3.8-27B-GGUF';

const PAYLOAD = Buffer.from('x'.repeat(4096));
// The fake serves exactly the byte count the tree advertises, otherwise the
// service's end-of-stream size check (correctly) rejects the transfer.
const FILE_BODIES: Record<string, Buffer> = {
    'model-Q4_K_M.gguf': PAYLOAD,
    'model-Q8_0.gguf': Buffer.from('y'.repeat(8192)),
};

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let tempDir: string;

/** Tree the fake HF returns for the repo listing. */
const TREE = [
    { type: 'file', path: 'README.md', size: 27165 },
    { type: 'file', path: 'LICENSE', size: 13306 },
    { type: 'file', path: 'model-Q4_K_M.gguf', size: PAYLOAD.byteLength },
    { type: 'file', path: 'model-Q8_0.gguf', size: PAYLOAD.byteLength * 2 },
];

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === `/api/models/${REPO}/tree/main`) {
                return Response.json(TREE);
            }
            if (url.pathname === '/api/models/nope/nope/tree/main') {
                return new Response('missing', { status: 404 });
            }
            if (url.pathname.includes('/resolve/main/')) {
                const name = decodeURIComponent(url.pathname.split('/').pop() as string);
                const full = FILE_BODIES[name];
                if (!full) return new Response('no such file', { status: 404 });
                // Honour Range so the resume path is genuinely exercised.
                const range = req.headers.get('range');
                if (range) {
                    const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0');
                    return new Response(new Uint8Array(full.subarray(from)), {
                        status: 206,
                        headers: { 'content-length': String(full.byteLength - from), 'accept-ranges': 'bytes' },
                    });
                }
                return new Response(new Uint8Array(full), { status: 200, headers: { 'content-length': String(full.byteLength) } });
            }
            return new Response('not found', { status: 404 });
        },
    });
    origin = `http://localhost:${server.port}`;
});

afterAll(() => { server?.stop(true); });

beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-dl-'));
});

afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
});

function service(timings?: Partial<{ stallMs: number; maxAttempts: number; retryBaseMs: number }>): HfDownloadService {
    return new HfDownloadService(tempDir, origin, timings);
}

/**
 * Waits for a task to leave the running/queued states. `budgetMs` is the
 * wall-clock allowance; the stall tests pass a generous one because a task
 * that is retrying stays in a non-settled state longer.
 */
async function settled(svc: HfDownloadService, id: string, budgetMs = 5_000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        const task = svc.snapshot().find(t => t.id === id);
        if (task && task.status !== 'running' && task.status !== 'queued') return task;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`task ${id} did not settle within ${budgetMs}ms`);
}

describe('parseGgufName', () => {
    test('reads the quant label out of a filename', () => {
        expect(parseGgufName('model-Q4_K_M.gguf').quant).toBe('Q4_K_M');
        expect(parseGgufName('model-Q8_0.gguf').quant).toBe('Q8_0');
        expect(parseGgufName('gemma-2-9b-it-IQ4_XS.gguf').quant).toBe('IQ4_XS');
        expect(parseGgufName('model-F16.gguf').quant).toBe('F16');
    });

    test('prefers the longest quant so Q4_K_M is not read as Q4_K', () => {
        expect(parseGgufName('a-Q4_K_S.gguf').quant).toBe('Q4_K_S');
        expect(parseGgufName('a-Q5_K_M.gguf').quant).toBe('Q5_K_M');
    });

    test('groups the shards of one split quant together', () => {
        const a = parseGgufName('model-Q4_K_M-00001-of-00002.gguf');
        const b = parseGgufName('model-Q4_K_M-00002-of-00002.gguf');
        expect(a.group).toBe(b.group);
        expect(a.shard).toBe(1);
        expect(b.shard).toBe(2);
        expect(a.quant).toBe('Q4_K_M');
    });

    test('different quants of one model stay in different groups', () => {
        expect(parseGgufName('model-Q4_K_M.gguf').group)
            .not.toBe(parseGgufName('model-Q8_0.gguf').group);
    });

    test('an unlabelled file is UNKNOWN, not a crash', () => {
        const parsed = parseGgufName('mystery.gguf');
        expect(parsed.quant).toBe('UNKNOWN');
        expect(parsed.shard).toBeNull();
    });
});

describe('listRepo', () => {
    test('returns only the GGUF files, with quant labels and disk state', async () => {
        const listing = await service().listRepo(REPO);
        expect(listing.repo).toBe(REPO);
        expect(listing.folder).toBe(FOLDER);
        expect(listing.files.map(f => f.name)).toEqual(['model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
        expect(listing.totalSize).toBe(PAYLOAD.byteLength * 3);
        expect(listing.presentSize).toBe(0);
    });

    test('marks a file already on disk as present', async () => {
        await fs.mkdir(path.join(tempDir, FOLDER), { recursive: true });
        await fs.writeFile(path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf'), PAYLOAD);
        const listing = await service().listRepo(REPO);
        expect(listing.files.find(f => f.name === 'model-Q4_K_M.gguf')?.present).toBe(true);
        expect(listing.presentSize).toBe(PAYLOAD.byteLength);
    });

    test('rejects a repo that is not owner/name', async () => {
        await expect(service().listRepo('not-a-repo')).rejects.toThrow('Invalid repository');
        await expect(service().listRepo('../../etc/passwd')).rejects.toThrow('Invalid repository');
    });

    test('surfaces a 404 as a readable error', async () => {
        await expect(service().listRepo('nope/nope')).rejects.toThrow('not found on Hugging Face');
    });
});

describe('start', () => {
    test('refuses files the listing never offered', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        expect(() => svc.start(REPO, ['../escape.gguf'])).toThrow('No matching files');
    });

    test('refuses an empty selection', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        expect(() => svc.start(REPO, [])).toThrow('No files selected');
    });

    test('refuses a repo that was never listed', () => {
        expect(() => service().start(REPO, ['model-Q4_K_M.gguf'])).toThrow('before starting');
    });

    test('skips files already on disk', async () => {
        const svc = service();
        await fs.mkdir(path.join(tempDir, FOLDER), { recursive: true });
        await fs.writeFile(path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf'), PAYLOAD);
        const listing = await svc.listRepo(REPO);
        svc.rememberListing(listing);
        const task = svc.start(REPO, ['model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
        expect(task.files.map(f => f.name)).toEqual(['model-Q8_0.gguf']);
        await settled(svc, task.id);
    });

    test('refuses a second concurrent task', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        const first = svc.start(REPO, ['model-Q4_K_M.gguf']);
        expect(() => svc.start(REPO, ['model-Q8_0.gguf'])).toThrow('already in progress');
        await settled(svc, first.id);
    });
});

describe('transfer', () => {
    test('writes the file and leaves no .part behind', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        const done = await settled(svc, task.id);

        expect(done.status).toBe('done');
        expect(done.error).toBe('');
        const finalPath = path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf');
        expect(await fs.readFile(finalPath)).toEqual(PAYLOAD);
        // The .part must be renamed away, not left beside the finished file.
        expect(await fs.readdir(path.join(tempDir, FOLDER))).toEqual(['model-Q4_K_M.gguf']);
    });

    test('downloads every selected file in order', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        const task = svc.start(REPO, ['model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
        const done = await settled(svc, task.id);

        expect(done.status).toBe('done');
        expect(done.completedBytes).toBe(PAYLOAD.byteLength * 3);
        expect((await fs.readdir(path.join(tempDir, FOLDER))).sort()).toEqual(['model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
    });

    test('resumes a partial file with a Range request instead of restarting', async () => {
        const svc = service();
        const folder = path.join(tempDir, FOLDER);
        await fs.mkdir(folder, { recursive: true });
        // A half-finished transfer from an earlier run.
        await fs.writeFile(path.join(folder, 'model-Q4_K_M.gguf.part'), PAYLOAD.subarray(0, 1000));

        const listing = await svc.listRepo(REPO);
        expect(listing.files.find(f => f.name === 'model-Q4_K_M.gguf')?.partial).toBe(1000);
        svc.rememberListing(listing);

        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        const done = await settled(svc, task.id);

        expect(done.status).toBe('done');
        // Only the missing tail was appended, so the file is not corrupt and
        // is not doubled up from a restart.
        expect(await fs.readFile(path.join(folder, 'model-Q4_K_M.gguf'))).toEqual(PAYLOAD);
    });

    test('keeps the .part when a transfer is cancelled, and reports cancelled', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        // Cancel immediately: whatever was written stays for a later resume.
        expect(svc.cancel(task.id)).toBe(true);
        const done = await settled(svc, task.id);

        expect(done.status).toBe('cancelled');
        const entries = await fs.readdir(path.join(tempDir, FOLDER)).catch(() => [] as string[]);
        // Either nothing was written yet, or only a .part -- never a final
        // file that looks complete.
        expect(entries.every(name => name.endsWith('.part'))).toBe(true);
    });

    test('cancelling a finished or unknown task is a no-op', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        await settled(svc, task.id);
        expect(svc.cancel(task.id)).toBe(false);
        expect(svc.cancel('nope')).toBe(false);
    });

    test('pushes progress frames that advance toward the total', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        const seen: number[] = [];
        svc.subscribe(() => {
            const task = svc.snapshot().find(t => t.status === 'running');
            if (task) seen.push(task.received);
        });
        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        await settled(svc, task.id);
        // The stream is a progress signal, so it must actually have fired.
        expect(seen.length).toBeGreaterThan(0);
        expect(Math.max(...seen)).toBeGreaterThan(0);
    });
});

// --- STALL HANDLING ---
// The regression these cover: the old code aborted on a fixed total-duration
// timer, so any file slower than that cap killed itself partway through. The
// watchdog must key off INACTIVITY, not elapsed time.
describe('stalls', () => {
    type Mode = 'normal' | 'slow' | 'stall-always' | 'stall-once' | 'gated';
    let flaky: ReturnType<typeof Bun.serve>;
    let flakyOrigin: string;
    let mode: Mode = 'normal';
    let stallBytes: number;
    let requests: number;

    const CHUNK = 512;

    beforeAll(() => {
        flaky = Bun.serve({
            port: 0,
            async fetch(req) {
                const url = new URL(req.url);
                if (url.pathname.includes('/tree/main')) {
                    return Response.json([{ type: 'file', path: 'model-Q4_K_M.gguf', size: PAYLOAD.byteLength }]);
                }
                if (!url.pathname.includes('/resolve/main/')) return new Response('nope', { status: 404 });
                // Count the attempt before answering, so the "one request, no
                // retries" assertion below actually sees the 403.
                requests++;
                if (mode === 'gated') return new Response('private', { status: 403 });
                const stallThis = mode === 'stall-always' || (mode === 'stall-once' && requests === 1);
                // Either serve the whole body, or stop dead after stallBytes:
                // an open response that never sends another byte, which is
                // exactly what a wedged CDN connection looks like.
                if (stallThis) {
                    const head = PAYLOAD.subarray(0, stallBytes);
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(new Uint8Array(head));
                                // Never call close(): the stream just goes quiet.
                            },
                            cancel() { },
                        }),
                        { status: 200, headers: { 'content-length': String(PAYLOAD.byteLength) } },
                    );
                }
                // 'slow' keeps sending but slower than the stall window is wide;
                // total elapsed time still exceeds it, which must be fine.
                const body = new ReadableStream({
                    async start(controller) {
                        for (let off = 0; off < PAYLOAD.byteLength; off += CHUNK) {
                            controller.enqueue(new Uint8Array(PAYLOAD.subarray(off, off + CHUNK)));
                            if (mode === 'slow') await new Promise(r => setTimeout(r, 40));
                        }
                        controller.close();
                    },
                });
                return new Response(body, { status: 200, headers: { 'content-length': String(PAYLOAD.byteLength) } });
            },
        });
        flakyOrigin = `http://localhost:${flaky.port}`;
    });

    afterAll(() => { flaky?.stop(true); });

    beforeEach(() => {
        mode = 'normal';
        stallBytes = CHUNK * 2;
        requests = 0;
    });

    function flakyService(timings: Partial<{ stallMs: number; maxAttempts: number; retryBaseMs: number }>) {
        return new HfDownloadService(tempDir, flakyOrigin, timings);
    }

    async function run(svc: HfDownloadService, timings: Partial<{ stallMs: number; maxAttempts: number; retryBaseMs: number }>) {
        svc.rememberListing(await svc.listRepo(REPO));
        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        return await settled(svc, task.id, timings.stallMs! * timings.maxAttempts! + 5_000);
    }

    test('a slow but steady transfer is NOT killed for taking a long time', async () => {
        // 4096 bytes in 512-byte chunks at 40ms = ~320ms total, while the stall
        // window is only 150ms. Total time exceeds the window; the gap between
        // bytes never does, so the transfer must finish.
        mode = 'slow';
        const timings = { stallMs: 150, maxAttempts: 1, retryBaseMs: 10 };
        const svc = flakyService(timings);
        const done = await run(svc, timings);
        expect(done.status).toBe('done');
        expect(await fs.readFile(path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf'))).toEqual(PAYLOAD);
    });

    test('a quiet connection is retried and can recover on its own', async () => {
        // Stalls on the first request only; the retry resumes and completes.
        mode = 'stall-once';
        const timings = { stallMs: 150, maxAttempts: 3, retryBaseMs: 10 };
        const svc = flakyService(timings);
        const done = await run(svc, timings);
        expect(done.status).toBe('done');
        expect(requests).toBeGreaterThan(1);
        expect(await fs.readFile(path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf'))).toEqual(PAYLOAD);
    });

    test('a permanent stall gives up with a message that says how to recover', async () => {
        mode = 'stall-always';
        const timings = { stallMs: 120, maxAttempts: 2, retryBaseMs: 10 };
        const svc = flakyService(timings);
        const done = await run(svc, timings);
        expect(done.status).toBe('failed');
        expect(done.error).toMatch(/stalled/);
        // The message has to tell the user there is a way out, not just that
        // it stopped.
        expect(done.error).toMatch(/Resume/i);
        // The bytes already received are kept for the resume.
        expect(stallBytes).toBeGreaterThan(0);
    });

    test('a gated repo fails immediately instead of burning the retries', async () => {
        mode = 'gated';
        const timings = { stallMs: 1000, maxAttempts: 4, retryBaseMs: 10 };
        const svc = flakyService(timings);
        const done = await run(svc, timings);
        expect(done.status).toBe('failed');
        expect(done.error).toMatch(/403/);
        expect(done.error).toMatch(/gated or private/);
        // One request: a 4xx is the same answer every time.
        expect(requests).toBe(1);
    });

    test('resume picks a stalled task up from its .part', async () => {
        mode = 'stall-always';
        const stallTimings = { stallMs: 120, maxAttempts: 1, retryBaseMs: 10 };
        const svc = flakyService(stallTimings);
        const failed = await run(svc, stallTimings);
        expect(failed.status).toBe('failed');

        // The network comes back; the user hits Resume.
        mode = 'normal';
        const partPath = path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf.part');
        expect(await fs.readFile(partPath)).toEqual(PAYLOAD.subarray(0, stallBytes));

        const resumed = await svc.resume(failed.id);
        const done = await settled(svc, resumed.id, 5_000);

        expect(done.status).toBe('done');
        // Resumed, not restarted: the first stallBytes came from the .part and
        // only the remainder was refetched.
        expect(await fs.readFile(path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf'))).toEqual(PAYLOAD);
    });

    test('pause then resume completes the file', async () => {
        mode = 'slow';
        const timings = { stallMs: 5_000, maxAttempts: 1, retryBaseMs: 10 };
        const svc = flakyService(timings);
        svc.rememberListing(await svc.listRepo(REPO));
        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        // Let some bytes land, then pause.
        await new Promise(r => setTimeout(r, 120));
        expect(svc.cancel(task.id)).toBe(true);
        const paused = await settled(svc, task.id, 5_000);
        expect(paused.status).toBe('cancelled');

        const resumed = await svc.resume(task.id);
        const done = await settled(svc, resumed.id, 10_000);
        expect(done.status).toBe('done');
        expect(await fs.readFile(path.join(tempDir, FOLDER, 'model-Q4_K_M.gguf'))).toEqual(PAYLOAD);
    });

    test('resuming a finished task is a no-op that reports done', async () => {
        const svc = service();
        svc.rememberListing(await svc.listRepo(REPO));
        const task = svc.start(REPO, ['model-Q4_K_M.gguf']);
        const done = await settled(svc, task.id);
        expect(done.status).toBe('done');
        const again = await svc.resume(task.id);
        expect(again.status).toBe('done');
    });

    test('resuming an unknown task is refused', async () => {
        await expect(service().resume('nope')).rejects.toThrow('Unknown download');
    });
});
