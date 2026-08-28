// /api/llama/* proxy (Phase 3 — new endpoint, not part of the frozen P1 API):
// chat + slots requests must reach the launched model server through the
// dashboard so browsers never dial a model host directly (including
// streaming responses). Fake children: fake-llama-server.sh boots
// fake-llama-http.ts on the launched port.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as http from 'node:http';
import { startTestServer, type TestServer } from './helpers/test-server';

function postJson(url: string, body: unknown): Promise<{ status: number | undefined; body: any }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (err) { reject(err); } });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function getSseState(url: string, untilState: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE state ' + untilState + ' not seen within ' + timeoutMs + 'ms')); }, timeoutMs);
        const req = http.get(url, res => {
            let buf = '';
            res.on('data', chunk => {
                buf += chunk.toString();
                let idx: number;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    for (const line of frame.split('\n')) {
                        if (!line.startsWith('data: ')) continue;
                        try {
                            const payload = JSON.parse(line.slice(6));
                            if (payload.state === untilState) { clearTimeout(timer); req.destroy(); resolve(payload); }
                        } catch { /* partial frame */ }
                    }
                }
            });
        });
        req.on('error', err => { clearTimeout(timer); reject(err); });
    });
}

describe('llama proxy (Phase 3)', () => {
    let server: TestServer;
    let modelPath: string;

    beforeAll(async () => {
        server = await startTestServer();
        modelPath = server.tempDir + '/models/fake.gguf';
    });

    afterAll(async () => {
        if (server) await server.stop();
    });

    it('answers 502 with a clear error when no model is launched', async () => {
        const res = await fetch(server.url('/api/llama/slots'));
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'Model server not reachable (is it launched?)' });
    });

    it('proxies slots and chat (streaming + non-streaming) once the model is up', async () => {
        const start = await postJson(server.url('/api/start'), { modelPath, build: 'fake', ctx: 4096, ngl: 1 });
        expect(start.status).toBe(200);
        await getSseState(server.url('/api/status'), 'ready', 10000);
        // Give the fake HTTP sidecar a moment to bind.
        let slots: Response | undefined;
        for (let i = 0; i < 50; i++) {
            try { slots = await fetch(server.url('/api/llama/slots')); if (slots.status === 200) break; } catch { /* not bound yet */ }
            await new Promise(r => setTimeout(r, 100));
        }
        if (!slots) throw new Error('llama slots endpoint never bound');
        expect(slots.status).toBe(200);
        expect(await slots.json()).toEqual([{ id: 0, state: 0, n_ctx: 0, n_prompt_tokens: 0, next_token: null }]);

        const chat = await fetch(server.url('/api/llama/v1/chat/completions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'fake', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(chat.status).toBe(200);
        expect(chat.headers.get('content-type')).toContain('text/event-stream');
        const text = await chat.text();
        expect(text).toContain('data:');
        expect(text).toContain('fake1 token');
        expect(text).toContain('data: [DONE]');

        const chatPlain = await fetch(server.url('/api/llama/v1/chat/completions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(chatPlain.status).toBe(200);
        expect((await chatPlain.json()).choices[0].message.content).toBe('fake reply');

        await postJson(server.url('/api/stop'), {});
    });
});
