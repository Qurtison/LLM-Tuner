// Regression test: the /api/status COMPLETION frame must parse into the
// client completions store. The server sends `COMPLETION:` + json (csvlog.ts),
// and SseLogPrefixes.COMPLETION is the bare `COMPLETION` — the client must skip
// the separator or JSON.parse throws on the leading `:` and the event is lost.
import { test, expect } from 'bun:test';
import { applySseFrame, getServerSnapshot } from '../src/client/state/server';
import { SseLogPrefixes } from '../shared/contracts';

function frame(log: string): string {
    return JSON.stringify({ state: 'ready', model: 'm.gguf', isRpc: false, log, error: '' });
}

test('COMPLETION frame with the server\'s prefix+colon populates completions', () => {
    const payload = { runId: 'r1', genTps: 42, genTokens: 200, aborted: false };
    applySseFrame(frame(SseLogPrefixes.COMPLETION + ':' + JSON.stringify(payload)));
    const snap = getServerSnapshot();
    expect(snap.completions.length).toBe(1);
    expect(snap.completions[0].runId).toBe('r1');
    expect(snap.completions[0].genTps).toBe(42);
    expect(snap.completions[0].genTokens).toBe(200);
});

test('non-COMPLETION log frames still clear log and do not add completions', () => {
    const before = getServerSnapshot().completions.length;
    applySseFrame(frame('some plain log line'));
    expect(getServerSnapshot().completions.length).toBe(before);
    expect(getServerSnapshot().state?.log ?? '').toBe('');
});
