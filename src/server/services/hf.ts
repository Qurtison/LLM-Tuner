// Hugging Face model downloads (model download modal).
//
// Files are pulled straight off huggingface.co with fetch and streamed to
// disk under the models dir, one subfolder per repo:
//
//   models/<owner>--<name>/<file>.gguf
//
// Every transfer lands in a `<file>.part` sibling first and is renamed only
// after the last byte is written, so a killed server never leaves a truncated
// model that looks complete. A leftover .part is resumed with an HTTP Range
// request instead of being thrown away.
//
// Progress is pushed over /api/hf/download/stream (see routes/hf.ts); the
// client never polls per-byte.
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import type { HfDownloadTask, HfRepoFile, HfRepoListing } from '../../../shared/contracts';
import { resolveInside } from './files';

const HF_ORIGIN = 'https://huggingface.co';
// A 10 GB transfer must not sit on a dead connection forever; the same timer
// guards headers and body, and aborts the same controller cancel() uses.
const LIST_TIMEOUT_MS = 15_000;
// Inactivity limit: how long a transfer may go WITHOUT a byte before it is
// treated as dead. This must never be a cap on total transfer time -- a 30 GB
// quant on a slow link is legitimately quiet-free for many minutes.
const STALL_TIMEOUT_MS = 45_000;
// How often the watchdog checks for inactivity.
const STALL_POLL_MS = 1_000;
// Transient network errors are retried in place, resuming from the .part.
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1_500;
// How often progress is pushed to subscribers. 250ms keeps the bar smooth
// without a flood of SSE frames on a 10 GB file.
const EMIT_INTERVAL_MS = 250;
// Finished tasks are kept for the modal to render, then dropped.
const HISTORY_LIMIT = 20;

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class HfDownloadService {
    private readonly modelsDir: string;
    // Seam for the test suite: a local Bun.served stand-in for HF, so the
    // download/resume/rename path is exercised without touching the network.
    private readonly origin: string;
    private readonly tasks = new Map<string, HfDownloadTask>();
    /** id -> controllers for the in-flight requests, so cancel() can abort. */
    private readonly inFlight = new Map<string, AbortController>();
    private readonly listeners = new Set<() => void>();
    private counter = 0;

    private readonly timings: { stallMs: number; maxAttempts: number; retryBaseMs: number };

    constructor(modelsDir: string, origin: string = HF_ORIGIN, timings: Partial<{ stallMs: number; maxAttempts: number; retryBaseMs: number }> = {}) {
        this.modelsDir = modelsDir;
        this.origin = origin.replace(/\/+$/, '');
        this.timings = {
            stallMs: timings.stallMs ?? STALL_TIMEOUT_MS,
            maxAttempts: timings.maxAttempts ?? MAX_ATTEMPTS,
            retryBaseMs: timings.retryBaseMs ?? RETRY_BASE_MS,
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private emit(): void {
        for (const listener of this.listeners) {
            try { listener(); } catch { /* a bad listener must not break a download */ }
        }
    }

    snapshot(): HfDownloadTask[] {
        return [...this.tasks.values()].map(task => ({ ...task }));
    }

    /** models-dir-relative folder for a repo; slashes become `--` so one repo is one folder. */
    folderFor(repo: string): string {
        return repo.replace('/', '--');
    }

    private absolute(folder: string, name: string): string {
        return resolveInside(this.modelsDir, folder ? `${folder}/${name}` : name);
    }

    // --- REPO LISTING ---

    async listRepo(repo: string): Promise<HfRepoListing> {
        if (!REPO_PATTERN.test(repo)) throw new Error('Invalid repository (expected owner/name)');
        // ?recursive=1 so a quant nested in a subfolder still shows up; the
        // tree API is paginated at 1000 entries, which no GGUF repo reaches.
        const upstream = await fetch(
            `${this.origin}/api/models/${repo}/tree/main?recursive=true&limit=1000`,
            { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
        );
        if (upstream.status === 404) throw new Error('Repository not found on Hugging Face');
        if (!upstream.ok) throw new Error(`Hugging Face returned ${upstream.status}`);
        const tree: unknown = await upstream.json();
        if (!Array.isArray(tree)) throw new Error('Invalid Hugging Face response');

        const folder = this.folderFor(repo);
        const ggufs: HfRepoFile[] = [];
        for (const node of tree) {
            if (!node || typeof node !== 'object') continue;
            const entry = node as { type?: string; path?: string; size?: number };
            // LFS pointers report the pointer size in `size` only for small
            // files; real GGUF rows carry their true byte count.
            if (entry.type !== 'file' || typeof entry.path !== 'string') continue;
            if (!entry.path.toLowerCase().endsWith('.gguf')) continue;
            if (typeof entry.size !== 'number' || entry.size <= 0) continue;
            const name = entry.path.split('/').pop() as string;
            ggufs.push(await this.describeFile(folder, entry.path, name, entry.size));
        }
        if (ggufs.length === 0) throw new Error('No GGUF files in that repository');
        // Shard counts are only knowable once every file is in hand.
        this.recountShards(ggufs);
        ggufs.sort((a, b) => a.group.localeCompare(b.group) || a.shard - b.shard);

        let totalSize = 0;
        let presentSize = 0;
        for (const file of ggufs) {
            totalSize += file.size;
            if (file.present) presentSize += file.size;
        }
        return { repo, folder, files: ggufs, totalSize, presentSize };
    }

    /** Adds the quant label / shard info and probes the disk for an existing copy. */
    private async describeFile(folder: string, repoPath: string, name: string, size: number): Promise<HfRepoFile> {
        const { group, quant, shard } = parseGgufName(name);
        return {
            path: repoPath,
            name,
            size,
            quant,
            group,
            shard: shard ?? 0,
            shards: 1, // recountShards fixes this once the whole list is known
            present: await this.sizeOf(this.absolute(folder, name)) === size,
            partial: await this.sizeOf(this.absolute(folder, `${name}.part`)) ?? 0,
        };
    }

    private async sizeOf(target: string): Promise<number | null> {
        try {
            const stat = await fs.stat(target);
            return stat.isFile() ? stat.size : null;
        } catch {
            return null;
        }
    }

    private recountShards(files: HfRepoFile[]): void {
        const byGroup = new Map<string, HfRepoFile[]>();
        for (const file of files) {
            const bucket = byGroup.get(file.group);
            if (bucket) bucket.push(file); else byGroup.set(file.group, [file]);
        }
        for (const bucket of byGroup.values()) {
            const shards = bucket.length;
            for (const file of bucket) file.shards = shards;
        }
    }

    // --- TASK LIFECYCLE ---

    start(repo: string, requested: string[]): HfDownloadTask {
        if (!REPO_PATTERN.test(repo)) throw new Error('Invalid repository (expected owner/name)');
        const listing = this.listingFor(repo);
        const wanted = [...new Set(requested.filter(name => typeof name === 'string' && name))];
        if (wanted.length === 0) throw new Error('No files selected');
        // Only accept names the listing actually contains, so a crafted
        // request cannot steer the write out of the repo folder.
        const files = listing.files.filter(file => wanted.includes(file.name));
        if (files.length === 0) throw new Error('No matching files in that repository');
        // A file already on disk at full size is not re-fetched.
        const queue = files.filter(file => !file.present);
        if (queue.length === 0) throw new Error('All selected files are already downloaded');

        this.assertIdle();
        return this.enqueue(repo, queue);
    }

    // PAUSE / RESUME
    // cancel() is the pause: it aborts the request but leaves the .part, so
    // nothing already fetched is thrown away. resume() picks the transfer up
    // again, re-checking the disk first so files that finished while the task
    // was paused are not fetched twice.
    async resume(id: string): Promise<HfDownloadTask> {
        const previous = this.tasks.get(id);
        if (!previous) throw new Error('Unknown download');
        if (previous.status === 'running' || previous.status === 'queued') throw new Error('Download is already running');
        this.assertIdle();

        const queue: HfRepoFile[] = [];
        for (const file of previous.files) {
            const onDisk = await this.sizeOf(this.absolute(previous.folder, file.name));
            if (onDisk === file.size) continue; // finished before the pause
            queue.push({ ...file, present: false });
        }
        if (queue.length === 0) {
            previous.status = 'done';
            previous.error = '';
            previous.received = 0;
            previous.total = 0;
            previous.bytesPerSecond = 0;
            this.emit();
            return { ...previous };
        }
        return this.enqueue(previous.repo, queue);
    }

    private assertIdle(): void {
        if ([...this.tasks.values()].some(task => task.status === 'running' || task.status === 'queued')) {
            throw new Error('A download is already in progress');
        }
    }

    private enqueue(repo: string, queue: HfRepoFile[]): HfDownloadTask {
        const task: HfDownloadTask = {
            id: `dl${Date.now().toString(36)}${(this.counter++).toString(36)}`,
            repo,
            folder: this.folderFor(repo),
            status: 'queued',
            files: queue,
            fileIndex: 0,
            received: 0,
            total: queue[0].size,
            completedBytes: 0,
            taskTotal: queue.reduce((sum, file) => sum + file.size, 0),
            bytesPerSecond: 0,
            error: '',
            startedAt: Date.now(),
        };
        this.tasks.set(task.id, task);
        this.prune();
        void this.run(task);
        this.emit();
        return { ...task };
    }

    cancel(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task) return false;
        if (task.status !== 'running' && task.status !== 'queued') return false;
        task.status = 'cancelled';
        // Abort kills the fetch; the .part file stays for a later resume.
        this.inFlight.get(id)?.abort();
        this.emit();
        return true;
    }

    private prune(): void {
        const settled = [...this.tasks.values()]
            .filter(task => task.status !== 'running' && task.status !== 'queued')
            .sort((a, b) => a.startedAt - b.startedAt);
        while (settled.length > HISTORY_LIMIT) {
            const task = settled.shift();
            if (task) this.tasks.delete(task.id);
        }
    }

    /** Cache of the last listing per repo, so start() needs no second network call. */
    private readonly listings = new Map<string, HfRepoListing>();

    rememberListing(listing: HfRepoListing): void {
        this.listings.set(listing.repo, listing);
    }

    private listingFor(repo: string): HfRepoListing {
        const listing = this.listings.get(repo);
        if (!listing) throw new Error('Look the repository up before starting a download');
        return listing;
    }

    private async run(task: HfDownloadTask): Promise<void> {
        const targetDir = this.absolute(task.folder, '');
        try {
            await fs.mkdir(targetDir, { recursive: true });
        } catch (err) {
            this.fail(task, `Could not create ${task.folder}: ${messageOf(err)}`);
            return;
        }

        task.status = 'running';
        this.emit();

        for (let index = 0; index < task.files.length; index++) {
            if (isCancelled(task)) return;
            const file = task.files[index];
            task.fileIndex = index;
            task.received = file.partial; // a resumed part starts where it left off
            task.total = file.size;
            task.bytesPerSecond = 0;
            this.emit();
            // Transient failures (a dropped connection, a stalled CDN) are
            // retried in place. Each attempt re-stats the .part, so a retry
            // resumes from the last good byte instead of starting over.
            for (let attempt = 1; ; attempt++) {
                try {
                    await this.fetchOne(task, file);
                    break;
                } catch (err) {
                    if (isCancelled(task)) return;
                    if (isPermanent(err) || attempt >= this.timings.maxAttempts) {
                        const reason = messageOf(err);
                        this.fail(task, isStall(err)
                            ? `${file.name}: stalled (no data for ${Math.round(this.timings.stallMs / 1000)}s) after ${attempt} attempt${attempt === 1 ? '' : 's'}. Resume to continue.`
                            : `${file.name}: ${reason}`);
                        return;
                    }
                    task.error = `${file.name}: ${messageOf(err)} -- retrying (${attempt}/${this.timings.maxAttempts - 1})`;
                    this.emit();
                    await sleep(this.timings.retryBaseMs * attempt);
                    if (isCancelled(task)) return;
                }
            }
            if (isCancelled(task)) return;
            // Count the file as done only after the rename, so taskTotal
            // progress never runs ahead of what is on disk.
            task.completedBytes += file.size;
            task.received = 0;
            task.total = 0;
            task.bytesPerSecond = 0;
            this.emit();
        }

        if (task.status === 'running') {
            task.status = 'done';
            this.emit();
        }
    }

    private fail(task: HfDownloadTask, error: string): void {
        task.status = 'failed';
        task.error = error;
        task.bytesPerSecond = 0;
        this.emit();
    }

    private async fetchOne(task: HfDownloadTask, file: HfRepoFile): Promise<void> {
        const finalPath = this.absolute(task.folder, file.name);
        const partPath = `${finalPath}.part`;
        // Re-stat: the listing may be minutes old, and a finished .part from
        // an earlier run should not be downloaded again.
        const existing = (await this.sizeOf(partPath)) ?? 0;
        if (existing >= file.size) {
            await fs.rename(partPath, finalPath).catch(() => {});
            return;
        }
        task.received = existing;

        // The controller stays registered for the WHOLE transfer, headers and
        // body: dropping it after the response arrived left cancel() with
        // nothing to abort while a multi-GB body was still streaming.
        const controller = new AbortController();
        let stalled = false;
        this.inFlight.set(task.id, controller);
        // Stall watchdog: an INACTIVITY timer, reset by every chunk received.
        // A one-shot deadline here capped the whole transfer, so every file
        // over a few GB aborted itself partway through.
        let lastByteAt = Date.now();
        const watchdog = setInterval(() => {
            if (Date.now() - lastByteAt >= this.timings.stallMs) {
                stalled = true;
                controller.abort();
            }
        }, STALL_POLL_MS);
        try {
            return await this.stream(task, file, controller, existing, partPath, finalPath, () => { lastByteAt = Date.now(); });
        } catch (err) {
            // Tag a watchdog abort so the caller can say "stalled" instead of
            // the opaque "The operation was aborted."
            throw stalled ? new StallError(`${Math.round(this.timings.stallMs / 1000)}s without data`) : err;
        } finally {
            clearInterval(watchdog);
            this.inFlight.delete(task.id);
        }
    }

    private async stream(task: HfDownloadTask, file: HfRepoFile, controller: AbortController, existing: number, partPath: string, finalPath: string, markByte: () => void): Promise<void> {
        const response = await this.open(task, file, controller, existing);
        // validate() publishes the total on the task as a side effect.
        const { resumed } = await this.validate(response, task, file, existing, partPath);
        // A cancel mid-body returns false: there is nothing to finalize, and
        // the .part is left as-is so the next attempt resumes from it.
        if (!await this.writeBody(response, task, partPath, resumed, existing, markByte)) return;
        await this.finalize(task, partPath, finalPath);
    }

    /** Issues the GET, carrying a Range header when a .part is on disk. */
    private async open(task: HfDownloadTask, file: HfRepoFile, controller: AbortController, existing: number): Promise<Response> {
        const headers: Record<string, string> = {};
        if (existing > 0) headers.Range = 'bytes=' + existing + '-';
        return fetch(
            `${this.origin}/${task.repo}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}`,
            { headers, signal: controller.signal, redirect: 'follow' },
        );
    }

    /**
     * Turns the response into the two facts the writer needs -- whether the
     * resume was honoured, and how many bytes the file is in total -- or
     * throws. Drops a .part the server refused to resume from.
     */
    private async validate(response: Response, task: HfDownloadTask, file: HfRepoFile, existing: number, partPath: string): Promise<{ resumed: boolean; total: number }> {
        if (response.status === 416) {
            // Range past the end: the part is complete or corrupt. Start over.
            await fs.rm(partPath, { force: true });
            throw new Error('partial file was stale, retry to start over');
        }
        if (!response.ok && response.status !== 206) {
            const detail = `Hugging Face returned ${response.status}`;
            // 4xx (other than the 416 handled above) will not change on a
            // retry -- a missing or gated file fails the same way every time,
            // so say so instead of burning the retry budget.
            throw response.status >= 400 && response.status < 500
                ? new PermanentError(detail + (response.status === 403 ? ' (repo is gated or private)' : ''))
                : new Error(detail);
        }
        if (!response.body) throw new Error('Hugging Face sent an empty body');

        // 206 means the server honoured the resume; a 200 to a Range request
        // means it ignored it, so the part must be truncated before writing.
        const resumed = response.status === 206 && existing > 0;
        if (!resumed && existing > 0) await fs.rm(partPath, { force: true });
        if (!resumed) task.received = 0;

        const length = Number(response.headers.get('content-length') || '0');
        // x-linked-size is the authoritative size; content-length of a 206 is
        // only the remaining slice.
        const total = resumed ? existing + length : file.size;
        task.total = total || file.size;
        return { resumed, total };
    }

    /**
     * Copies the body to the .part, honouring write backpressure and throttling
     * progress to EMIT_INTERVAL_MS. Resolves false when the task was cancelled
     * part way through.
     */
    private async writeBody(response: Response, task: HfDownloadTask, partPath: string, resumed: boolean, existing: number, markByte: () => void): Promise<boolean> {
        const out = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' });
        // A write stream signals failure as an 'error' event, which nothing
        // awaits: without a permanent listener a failed open or a full disk
        // escapes as an uncaught exception. Capture it and let the task fail
        // with a readable message instead.
        let writeError: Error | null = null;
        out.on('error', err => { writeError = err instanceof Error ? err : new Error(String(err)); });
        let received = resumed ? existing : 0;
        let lastEmit = 0;
        const startedAt = Date.now();
        const baseBytes = received;

        try {
            const reader = response.body!.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                if (isCancelled(task)) {
                    await reader.cancel().catch(() => {});
                    return false;
                }
                received += value.byteLength;
                markByte();
                if (writeError) throw writeError;
                if (!out.write(value)) {
                    // Backpressure: wait for the fd to drain before reading more.
                    await new Promise<void>((resolve, reject) => {
                        out.once('drain', () => resolve());
                        out.once('error', reject);
                    });
                }
                task.received = received;
                const now = Date.now();
                if (now - lastEmit >= EMIT_INTERVAL_MS) {
                    const seconds = (now - startedAt) / 1000;
                    task.bytesPerSecond = seconds > 0 ? Math.max(0, (received - baseBytes) / seconds) : 0;
                    lastEmit = now;
                    this.emit();
                }
            }
        } finally {
            await new Promise<void>(resolve => { out.end(resolve); });
        }
        // Checked AFTER the close, not before it: a write can fail while the
        // stream is draining buffered chunks in out.end(), and that error only
        // arrives on the 'error' event. Testing inside the try block let those
        // through and returned true, so a short .part reached finalize().
        if (writeError) throw writeError;
        return true;
    }

    /** Size-checks the .part, then promotes it to the final name in one rename. */
    private async finalize(task: HfDownloadTask, partPath: string, finalPath: string): Promise<void> {
        const written = (await this.sizeOf(partPath)) ?? 0;
        if (written < task.total) throw new Error('stream ended early (' + written + ' of ' + task.total + ' bytes)');
        await fs.rename(partPath, finalPath);
        task.received = task.total;
    }
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// cancel() flips task.status from another closure, but TypeScript keeps the
// 'running' narrowing it inferred at the assignment, so the flag is read
// through this helper instead of compared inline.
function isCancelled(task: HfDownloadTask): boolean {
    return task.status === 'cancelled';
}

/** Thrown by the inactivity watchdog; retried, then reported as a stall. */
class StallError extends Error {}

function isStall(err: unknown): boolean {
    return err instanceof StallError;
}

/** 4xx-style failures that will never succeed on a retry. */
class PermanentError extends Error {}

function isPermanent(err: unknown): boolean {
    return err instanceof PermanentError;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- GGUF NAME PARSING ---
//
// Quant labels are matched longest-first, otherwise Q4_K_M would be read as
// Q4_K + a "_M" suffix. Splits are recognised by the usual
// <stem>-00001-of-00003.gguf / -part-00001-of-00003.gguf suffixes.
const QUANTS = [
    'IQ1_S', 'IQ1_M', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M',
    'IQ3_XXS', 'IQ3_XS', 'IQ3_S', 'IQ3_M', 'IQ4_XS', 'IQ4_NL',
    // The community also ships _XL/_L/_S variants that upstream llama.cpp
    // does not define; without them Q4_K_L and Q6_K_L read as Q4_K and Q6_K,
    // which mislabels the row and splits one quant into two entries.
    'Q2_K', 'Q2_K_S', 'Q2_K_XL', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q3_K_XL',
    'Q4_0', 'Q4_1', 'Q4_K_S', 'Q4_K_M', 'Q4_K_L', 'Q4_K_XL',
    'Q5_0', 'Q5_1', 'Q5_K_S', 'Q5_K_M', 'Q5_K_L', 'Q5_K_XL',
    'Q6_K', 'Q6_K_S', 'Q6_K_L', 'Q6_K_XL', 'Q8_0', 'TQ1_0', 'TQ2_0',
    'BF16', 'F16', 'F32',
];
const QUANT_PATTERN = new RegExp('(' + [...QUANTS].sort((a, b) => b.length - a.length).join('|') + ')', 'i');
const SHARD_PATTERN = /^(.*?)-(?:part-)?(\d{5})-of-(\d{5})$/i;

export function parseGgufName(name: string): { group: string; quant: string; shard: number | null } {
    const stem = name.replace(/\.gguf$/i, '');
    const shardMatch = SHARD_PATTERN.exec(stem);
    const base = shardMatch ? shardMatch[1] : stem;
    const quantMatch = QUANT_PATTERN.exec(base);
    const quant = quantMatch ? quantMatch[1].toUpperCase() : 'UNKNOWN';
    // The group key must be identical for every shard of one split quant, and
    // must still separate different quants of the same model.
    const groupBase = quantMatch ? base.slice(0, quantMatch.index) + quant : base;
    return {
        group: (shardMatch ? groupBase : stem).toLowerCase(),
        quant,
        shard: shardMatch ? Number.parseInt(shardMatch[2], 10) : null,
    };
}
