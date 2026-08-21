// Shared server state for the React client (Phase 5).
//
// One SSE owner (the app shell) parses every frame and fans out to
// typed stores; every feature panel reads via useServer() and never
// opens its own EventSource. This is the React replacement for the
// script.js singleton globals (eventSource/lastSseAt/lastKnownServerState
// etc. — see docs/p5-slices.md, cross-slice globals table).
import { useSyncExternalStore } from 'react';
import type { ConfigResponse, SseStatePayload, CompletionEvent } from '../../../shared/contracts';
import { SseLogPrefixes } from '../../../shared/contracts';

class Value<T> {
    private value: T;
    private listeners = new Set<() => void>();
    constructor(initial: T) { this.value = initial; }
    get(): T { return this.value; }
    set(next: T): void { if (next === this.value) return; this.value = next; this.listeners.forEach(l => l()); }
    subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
}

// Benches/monitor/chat subscribe to raw SSE log lines (BENCH:, BENCH_DONE:
// etc.) without the shell needing to know about them.
type LineListener = (line: string) => void;
const lineListeners = new Set<LineListener>();
export function onSseLine(listener: LineListener): () => void {
    lineListeners.add(listener);
    return () => { lineListeners.delete(listener); };
}
function emitLine(line: string): void {
    lineListeners.forEach(l => { try { l(line); } catch { /* listener bug must not kill the stream */ } });
}

export interface ServerSnapshot {
    // Latest state payload from every /api/status frame (state/model/log/...
    // error channel is the payload's error field; non-SSE errors arrive as
    // log lines starting with the prefixes below).
    state: SseStatePayload | null;
    config: ConfigResponse | null;
    // Completed requests (any client — frozen COMPLETION semantics) newest
    // first, capped. Monitor/History/metrics read from here.
    completions: CompletionEvent[];
    // Live progress for the in-flight request (PREFILL_PROGRESS / GEN_PROGRESS).
    progress: { prefill?: { progress: number; tps: string; tokens: number }; gen?: { tps: string; tokens: number } } | null;
    // Last telemetry sample set pushed by /api/telemetry polling owners.
    lastSseAt: number;
    connected: boolean;
}

// ponytail: completions persisted to localStorage so a browser refresh
// keeps recent request history; if cross-tab sync is ever needed, move to
// BroadcastChannel or a server round-trip.
const COMPLETIONS_KEY = 'server_completions';
function loadCompletions(): CompletionEvent[] {
    try {
        const value: unknown = JSON.parse(window.localStorage.getItem(COMPLETIONS_KEY) || '[]');
        return Array.isArray(value) ? value as CompletionEvent[] : [];
    } catch { return []; }
}
function saveCompletions(completions: CompletionEvent[]): void {
    try { window.localStorage.setItem(COMPLETIONS_KEY, JSON.stringify(completions)); } catch { /* full or unavailable */ }
}

const snapshot = new Value<ServerSnapshot>({
    state: null,
    config: null,
    completions: loadCompletions(),
    progress: null,
    lastSseAt: 0,
    connected: false,
});

export function getServerSnapshot(): ServerSnapshot { return snapshot.get(); }

// --- frame parsing (frozen dispatch table from docs/p5-slices.md) ---
export function applySseFrame(raw: string): void {
    let payload: SseStatePayload;
    try {
        payload = JSON.parse(raw) as SseStatePayload;
    } catch {
        return; // vanilla threw on malformed JSON; React must not (frozen intent)
    }
    const current = snapshot.get();
    let progress = current.progress;
    const log = payload.log || '';
    if (log.startsWith(SseLogPrefixes.PREFILL_PROGRESS)) {
        const [, p, tps, tokens] = log.split(':');
        progress = { ...progress, prefill: { progress: parseFloat(p), tps, tokens: parseInt(tokens, 10) } };
    } else if (log.startsWith(SseLogPrefixes.GEN_PROGRESS)) {
        const [, tps, tokens] = log.split(':');
        progress = { ...progress, gen: { tps, tokens: parseInt(tokens, 10) } };
    } else if (log.startsWith(SseLogPrefixes.CTX_LIVE)) {
        // Context usage arrives as its own frame; consumers re-poll the
        // slots endpoint — keep the parsed marker for the chat slice.
        progress = { ...progress, prefill: progress?.prefill, gen: progress?.gen };
        emitLine(log);
    } else if (log.startsWith(SseLogPrefixes.COMPLETION)) {
        try {
            const event = JSON.parse(log.slice(SseLogPrefixes.COMPLETION.length).trim()) as CompletionEvent;
            const completions = [event, ...current.completions].slice(0, 100);
            saveCompletions(completions);
            snapshot.set({ ...current, state: { ...payload, log: '' }, completions, lastSseAt: Date.now(), connected: true, progress: null });
            return;
        } catch {
            /* fall through: treat as plain line */
        }
    } else if (log) {
        emitLine(log);
    }
    snapshot.set({ ...current, state: { ...payload, log: '' }, progress, lastSseAt: Date.now(), connected: true });
}

export function setServerConfig(config: ConfigResponse): void {
    snapshot.set({ ...snapshot.get(), config });
}

export function setSseConnected(connected: boolean): void {
    snapshot.set({ ...snapshot.get(), connected });
}

export function useServer(): ServerSnapshot {
    // Arrows keep `this`; a bare snapshot.get reference would lose it.
    return useSyncExternalStore(snapshot.subscribe, () => snapshot.get(), () => snapshot.get());
}
