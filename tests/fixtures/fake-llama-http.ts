// Mini llama-server HTTP endpoints for /api/llama/* proxy tests. Launched by
// fake-llama-server.sh with FAKE_PORT once the fake model is "loaded".
export {}; // module marker: keep top-level consts out of the global scope (typecheck)
const port = Number(process.env.FAKE_PORT || 0);
Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch: async (req) => {
        if (req.url.endsWith('/slots')) {
            // Real llama-server /slots shape: a bare array of slot objects
            // (state 0 = free, 1 = busy) — the UI parses it as an array.
            return Response.json([{ id: 0, state: 0, n_ctx: 0, n_prompt_tokens: 0, next_token: null }]);
        }
        if (req.url.endsWith('/v1/chat/completions') && req.method === 'POST') {
            const body = await req.text();
            const wantsStream = body.includes('"stream"') && body.includes('true');
            if (wantsStream) {
                const stream = new ReadableStream({
                    start(controller) {
                        const enc = new TextEncoder();
                        const chunk = (n: number) => enc.encode('data: {"choices":[{"delta":{"content":"fake' + n + ' token"}}]}\n\n');
                        controller.enqueue(chunk(1));
                        setTimeout(() => {
                            controller.enqueue(chunk(2));
                            controller.enqueue(enc.encode('data: [DONE]\n\n'));
                            controller.close();
                        }, 50);
                    },
                });
                return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
            }
            return Response.json({ choices: [{ message: { content: 'fake reply' } }] });
        }
        return new Response('not found', { status: 404 });
    },
});
