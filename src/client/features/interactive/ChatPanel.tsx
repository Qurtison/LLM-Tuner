import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { onSseLine, useServer } from '../../state/server';

type Role = 'user' | 'assistant';
type Message = { role: Role; content: string; timestamp: string; reasoning?: string };
type Session = { id: string; messages: Message[] };
type Slot = { state?: number; n_ctx?: number; n_prompt_tokens?: number; next_token?: { n_decoded?: number } };

const HISTORY_KEY = 'cluster_chat_history';

function time(): string { return new Date().toLocaleTimeString(); }
function newId(): string { return String(Date.now()); }
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
function loadSessions(): Session[] {
    try {
        const raw = window.localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) throw new Error('invalid history');
        return value.filter((session): session is Session => !!session && typeof session === 'object' && typeof (session as Session).id === 'string' && Array.isArray((session as Session).messages));
    } catch {
        try { window.localStorage.removeItem(HISTORY_KEY); } catch { /* storage unavailable */ }
        return [];
    }
}
function saveSessions(sessions: Session[]): string | null {
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions)); return null; }
    catch { return 'Chat history could not be saved.'; }
}
function errorText(error: unknown): string {
    if (error instanceof ApiError) return error.status === 502 ? 'Model not launched. Start model, then retry.' : error.message || 'Request failed.';
    if (error instanceof DOMException && error.name === 'AbortError') return 'Generation stopped.';
    return error instanceof Error ? error.message : 'Request failed.';
}
function parseSse(buffer: string, onData: (value: unknown) => void): string {
    const lines = buffer.split(/\r?\n/);
    const rest = lines.pop() ?? '';
    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try { onData(JSON.parse(data)); } catch { /* wait for next valid SSE frame */ }
    }
    return rest;
}

export default function ChatPanel() {
    const { state } = useServer();
    const [sessions, setSessions] = useState<Session[]>(loadSessions);
    const [sessionId, setSessionId] = useState(newId);
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');
    const [thinking, setThinking] = useState('default');
    const [kwargs, setKwargs] = useState('');
    const [streaming, setStreaming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [slot, setSlot] = useState<Slot | null>(null);
    const [context, setContext] = useState<{ used: number; limit: number } | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);

    const persist = (nextMessages: Message[], id = sessionId) => {
        if (!nextMessages.length) return;
        const next = [...sessions.filter(item => item.id !== id), { id, messages: nextMessages }];
        setSessions(next);
        const storageError = saveSessions(next);
        if (storageError) setError(storageError);
    };

    useEffect(() => () => abortRef.current?.abort(), []);
    useEffect(() => {
        const unsubscribe = onSseLine(line => {
            if (!line.startsWith('CTX_LIVE:')) return;
            const [, usedText, limitText] = line.split(':');
            const used = Number.parseInt(usedText, 10);
            const limit = Number.parseInt(limitText, 10);
            if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) setContext({ used, limit });
        });
        return unsubscribe;
    }, []);
    useEffect(() => {
        let active = true;
        const poll = async () => {
            try {
                const slots = await api<Slot[]>('/api/llama/slots');
                if (!active) return;
                const next = slots.find(item => item.state === 1) ?? slots[0] ?? null;
                setSlot(next);
                const used = next?.n_ctx ?? next?.n_prompt_tokens;
                if (typeof used === 'number' && state?.launchConfig?.ctx) setContext({ used, limit: state.launchConfig.ctx });
            } catch (caught) {
                if (active && !(caught instanceof ApiError && caught.status === 502)) setError(errorText(caught));
            }
        };
        void poll();
        const interval = window.setInterval(() => { void poll(); }, 250);
        return () => { active = false; window.clearInterval(interval); };
    }, [state?.launchConfig?.ctx]);
    useEffect(() => {
        const element = containerRef.current;
        if (element && atBottomRef.current) element.scrollTop = element.scrollHeight;
    }, [messages]);

    const send = async () => {
        const content = draft.trim();
        if (!content || streaming) return;
        if (state?.state !== 'ready') { setError('Model unavailable. Start model before sending chat.'); return; }
        let chatTemplateKwargs: Record<string, unknown> = {};
        if (thinking === 'on') chatTemplateKwargs.enable_thinking = true;
        if (thinking === 'off') chatTemplateKwargs.enable_thinking = false;
        if (kwargs.trim()) {
            try {
                const parsed: unknown = JSON.parse(kwargs);
                if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('not object');
                chatTemplateKwargs = { ...chatTemplateKwargs, ...(parsed as Record<string, unknown>) };
            } catch { setError('Extra kwargs is not valid JSON — ignored for this request.'); }
        }
        const user: Message = { role: 'user', content, timestamp: time() };
        const assistant: Message = { role: 'assistant', content: '', timestamp: time() };
        const before = [...messages, user];
        const initial = [...before, assistant];
        setMessages(initial); setDraft(''); setError(null); setStreaming(true);
        const controller = new AbortController(); abortRef.current = controller;
        const requestMessages = [...(systemPrompt.trim() ? [{ role: 'system', content: systemPrompt.trim() }] : []), ...before.map(message => ({ role: message.role, content: message.content }))];
        try {
            // api() parses JSON; chat endpoint is SSE, so stream response directly through same-origin proxy.
            const response = await fetch('/api/llama/v1/chat/completions', { method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ model: state.launchConfig?.model ?? state.model, messages: requestMessages, stream: true, stream_options: { include_usage: true }, ...(Object.keys(chatTemplateKwargs).length ? { chat_template_kwargs: chatTemplateKwargs } : {}) }) });
            if (!response.ok) {
                let message = response.statusText;
                try { const body = await response.json() as { error?: string }; message = body.error || message; } catch { /* preserve status text */ }
                throw new ApiError(response.status, message);
            }
            let finalMessage = assistant;
            const update = (data: unknown) => {
                const value = data as { choices?: { delta?: { content?: string; reasoning_content?: string } }[] };
                const delta = value.choices?.[0]?.delta;
                if (!delta) return;
                finalMessage = { ...finalMessage, content: finalMessage.content + (delta.content || ''), reasoning: (finalMessage.reasoning || '') + (delta.reasoning_content || '') || undefined };
                setMessages([...before, finalMessage]);
            };
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('text/event-stream')) {
                if (!response.body) throw new Error('Chat stream unavailable.');
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffered = '';
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffered = parseSse(buffered + decoder.decode(value, { stream: true }), update);
                }
                parseSse(buffered + decoder.decode(), update);
            } else {
                const payload = await response.json() as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
                const message = payload.choices?.[0]?.message;
                finalMessage = { ...finalMessage, content: message?.content || '', reasoning: message?.reasoning_content || undefined };
                setMessages([...before, finalMessage]);
            }
            if (!finalMessage.content && !finalMessage.reasoning) throw new Error('Model returned an empty response.');
            persist([...before, finalMessage]);
        } catch (caught) {
            const stopped = caught instanceof DOMException && caught.name === 'AbortError';
            const failed = { ...assistant, content: stopped ? 'Generation stopped.' : errorText(caught) };
            setMessages([...before, failed]);
            persist([...before, failed]);
            setError(stopped ? 'Generation stopped.' : errorText(caught));
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setStreaming(false);
        }
    };
    const stop = () => abortRef.current?.abort();
    const newChat = () => { if (messages.length) persist(messages); setSessionId(newId()); setMessages([]); setContext(null); setError(null); };
    const clearHistory = () => {
        if (!window.confirm('Clear all chat history?')) return;
        try { window.localStorage.removeItem(HISTORY_KEY); } catch { setError('Chat history could not be cleared.'); }
        setSessions([]); setSessionId(newId()); setMessages([]); setContext(null);
    };
    const used = context?.used ?? slot?.n_ctx ?? slot?.n_prompt_tokens;
    const limit = context?.limit ?? state?.launchConfig?.ctx;

    return <section className="flex min-h-[42rem] flex-col rounded-xl border border-neutral-800 bg-neutral-900" aria-label="Chat">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3"><div><h2 className="text-sm font-semibold">Chat</h2><p className="text-xs text-neutral-500">{slot?.state === 1 ? 'Slot busy' : 'Slot available'}{typeof used === 'number' && limit ? ' · context ' + used.toLocaleString() + ' / ' + limit.toLocaleString() : ''}</p></div><div className="flex gap-2"><button type="button" onClick={newChat} className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700">New chat</button><button type="button" onClick={clearHistory} className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-red-300">Clear history</button></div></div>
        {error && <p role="alert" className="mx-4 mt-3 rounded border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">{error}</p>}
        <div ref={containerRef} onScroll={event => { const target = event.currentTarget; atBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 40; }} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
            {!messages.length && <p className="py-16 text-center text-sm text-neutral-500">{state?.state === 'ready' ? 'New chat started. Type prompt below.' : 'Model unavailable. Start model to begin.'}</p>}
            {messages.map((message, index) => <article key={index} className={message.role === 'user' ? 'rounded-xl border border-neutral-700 bg-neutral-800 p-4' : 'rounded-xl border border-indigo-900/40 bg-neutral-950 p-4'}><header className="mb-2 flex justify-between text-xs"><span className={message.role === 'user' ? 'text-neutral-300' : 'text-indigo-400'}>{message.role === 'user' ? 'User' : 'Assistant'}</span><time className="text-neutral-500">{message.timestamp}</time></header>{message.reasoning && <details className="mb-3 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400"><summary className="cursor-pointer">Reasoning trace</summary><pre className="mt-2 whitespace-pre-wrap font-mono">{message.reasoning}</pre></details>}<p className="whitespace-pre-wrap break-words text-sm text-neutral-100">{message.content || (streaming && index === messages.length - 1 ? 'Loading context…' : '')}</p></article>)}
        </div>
        <div className="border-t border-neutral-800 p-4"><div className="mb-2 flex flex-wrap gap-2"><input value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder="System prompt (optional)" className="min-w-48 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"/><select value={thinking} onChange={event => setThinking(event.target.value)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"><option value="default">Thinking default</option><option value="on">Thinking on</option><option value="off">Thinking off</option></select><input value={kwargs} onChange={event => setKwargs(event.target.value)} placeholder='extra kwargs JSON' className="w-48 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs"/></div><textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} disabled={streaming || state?.state !== 'ready'} placeholder={state?.state === 'ready' ? 'Message…' : 'Waiting for model…'} rows={3} className="w-full resize-none rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"/><div className="mt-2 flex items-center justify-between"><span className="text-xs text-neutral-500">~{estimateTokens(draft)} tokens</span>{streaming ? <button type="button" onClick={stop} className="rounded bg-red-900 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-800">Stop</button> : <button type="button" onClick={() => { void send(); }} disabled={!draft.trim() || state?.state !== 'ready'} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">Send</button>}</div></div>
        {sessions.length > 0 && <div className="border-t border-neutral-800 p-3"><h3 className="mb-2 text-xs font-semibold text-neutral-500">Chat history</h3><div className="max-h-32 space-y-1 overflow-y-auto">{[...sessions].sort((a, b) => Number(b.id) - Number(a.id)).map(session => <button key={session.id} type="button" onClick={() => { setSessionId(session.id); setMessages(session.messages); setError(null); }} className="block w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-400 hover:bg-neutral-800">{new Date(Number(session.id)).toLocaleString()} · {session.messages.length} msgs</button>)}</div></div>}
    </section>;
}
