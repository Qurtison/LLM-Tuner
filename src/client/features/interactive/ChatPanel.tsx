import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { getChatErrorMessage } from '../../api/errors';
import { sanitizeMarkdownHtml } from '../../lib/sanitize';
import { useServer } from '../../state/server';

type Role = 'user' | 'assistant';
type Message = { role: Role; content: string; timestamp: string; reasoning?: string; startedAt?: number; finishedAt?: number };
type Session = { id: string; messages: Message[] };
type Slot = { state?: number; n_ctx?: number; n_prompt_tokens?: number; next_token?: { n_decoded?: number } };

const HISTORY_KEY = 'cluster_chat_history';
const MSG_COLLAPSE_HEIGHT = 320;

function messageKey(message: Message, index: number): string { return message.timestamp + '-' + index; }
function duration(message: Message): string | null {
    if (!message.startedAt || !message.finishedAt) return null;
    return ((message.finishedAt - message.startedAt) / 1000).toFixed(1) + 's';
}

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
const errorText = getChatErrorMessage;
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
    const abortRef = useRef<AbortController | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    const contentRefs = useRef(new Map<string, HTMLDivElement>());
    const [rawMessages, setRawMessages] = useState<Record<string, boolean>>({});
    const [collapsedMessages, setCollapsedMessages] = useState<Record<string, boolean>>({});

    const persist = (nextMessages: Message[], id = sessionId) => {
        if (!nextMessages.length) return;
        const next = [...sessions.filter(item => item.id !== id), { id, messages: nextMessages }];
        setSessions(next);
        const storageError = saveSessions(next);
        if (storageError) setError(storageError);
    };

    useEffect(() => () => abortRef.current?.abort(), []);
    // Slots polled only while streaming — keeps "Slot busy/available" fresh
    // without 502-spamming when no model is launched.
    useEffect(() => {
        if (!streaming) return;
        let active = true;
        const poll = async () => {
            try {
                const slots = await api<Slot[]>('/api/llama/slots');
                if (!active) return;
                setSlot(slots.find(item => item.state === 1) ?? slots[0] ?? null);
            } catch (caught) {
                if (active && !(caught instanceof ApiError && caught.status === 502)) setError(errorText(caught));
            }
        };
        void poll();
        const interval = window.setInterval(() => { void poll(); }, 250);
        return () => { active = false; window.clearInterval(interval); };
    }, [streaming]);
    useEffect(() => {
        const element = containerRef.current;
        if (element && atBottomRef.current) element.scrollTop = element.scrollHeight;
    }, [messages]);
    useEffect(() => {
        if (streaming) return;
        const next: Record<string, boolean> = {};
        for (const [key, element] of contentRefs.current) {
            if (element.scrollHeight > MSG_COLLAPSE_HEIGHT + 40) next[key] = collapsedMessages[key] ?? true;
        }
        if (Object.keys(next).some(key => next[key] !== collapsedMessages[key]) || Object.keys(next).length !== Object.keys(collapsedMessages).length) setCollapsedMessages(next);
    }, [messages, streaming, collapsedMessages]);

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
        const startedAt = Date.now();
        const assistant: Message = { role: 'assistant', content: '', timestamp: time(), startedAt };
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
            finalMessage = { ...finalMessage, finishedAt: Date.now() };
            setMessages([...before, finalMessage]);
            persist([...before, finalMessage]);
        } catch (caught) {
            const stopped = caught instanceof DOMException && caught.name === 'AbortError';
            const failed = { ...assistant, content: stopped ? 'Generation stopped.' : errorText(caught), finishedAt: Date.now() };
            setMessages([...before, failed]);
            persist([...before, failed]);
            setError(stopped ? 'Generation stopped.' : errorText(caught));
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setStreaming(false);
        }
    };
    const stop = () => abortRef.current?.abort();
    const newChat = () => { if (messages.length) persist(messages); setSessionId(newId()); setMessages([]); setError(null); };
    const clearHistory = () => {
        if (!window.confirm('Clear all chat history?')) return;
        try { window.localStorage.removeItem(HISTORY_KEY); } catch { setError('Chat history could not be cleared.'); }
        setSessions([]); setSessionId(newId()); setMessages([]);
    };

    return <section className="flex min-h-[42rem] flex-col rounded-xl border border-neutral-800 bg-neutral-900" aria-label="Chat">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3"><div><h2 className="text-sm font-semibold">Chat</h2><p className="text-xs text-neutral-500">{slot?.state === 1 ? 'Slot busy' : 'Slot available'}<span className="ml-2 text-neutral-600">· context in Overview</span></p></div><div className="flex gap-2"><button type="button" onClick={newChat} className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700">New chat</button><button type="button" onClick={clearHistory} className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-red-300">Clear history</button></div></div>
        {error && <p role="alert" className="mx-4 mt-3 rounded border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">{error}</p>}
        <div ref={containerRef} onScroll={event => { const target = event.currentTarget; atBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 40; }} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
            {!messages.length && <p className="py-16 text-center text-sm text-neutral-500">{state?.state === 'ready' ? 'New chat started. Type prompt below.' : 'Model unavailable. Start model to begin.'}</p>}
{messages.map((message, index) => {
                const key = messageKey(message, index);
                const raw = rawMessages[key];
                const collapsed = collapsedMessages[key];
                const metadata = [message.timestamp, message.content.length.toLocaleString() + ' chars', '~' + estimateTokens(message.content) + ' tokens', message.reasoning ? message.reasoning.length.toLocaleString() + ' reasoning chars' : '', duration(message)].filter(Boolean).join(' · ');
                const content = message.content || (streaming && index === messages.length - 1 ? 'Loading context…' : '');
                return <article key={key} className={message.role === 'user' ? 'rounded-xl border border-neutral-700 bg-neutral-800 p-4' : 'rounded-xl border border-indigo-900/40 bg-neutral-950 p-4'}>
                    <header className="mb-2 flex items-center justify-between gap-3 text-xs"><span className={message.role === 'user' ? 'text-neutral-300' : 'text-indigo-400'}>{message.role === 'user' ? 'User' : 'Assistant'}</span><div className="flex items-center gap-3"><time className="text-neutral-500">{message.timestamp}</time>{message.role === 'assistant' && <button type="button" onClick={() => setRawMessages(current => ({ ...current, [key]: !raw }))} className="text-neutral-500 hover:text-neutral-300">{raw ? 'View Rendered' : 'View Raw'}</button>}</div></header>
                    <p className="mb-2 text-[10px] text-neutral-500" aria-label="Message metadata timeline">{metadata}</p>
                    {message.reasoning && <details className="mb-3 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400"><summary className="cursor-pointer">Reasoning trace · ~{estimateTokens(message.reasoning)} tokens</summary><pre className="mt-2 whitespace-pre-wrap font-mono">{message.reasoning}</pre></details>}
                    <div ref={element => { if (element) contentRefs.current.set(key, element); else contentRefs.current.delete(key); }} className={collapsed ? 'max-h-80 overflow-hidden' : ''}>{raw ? <pre className="overflow-x-auto rounded border border-neutral-800 bg-neutral-950 p-3 text-xs whitespace-pre-wrap break-words text-neutral-300">{content}</pre> : message.role === 'assistant' ? <div className="prose prose-invert max-w-none break-words text-sm" dangerouslySetInnerHTML={{ __html: sanitizeMarkdownHtml(marked.parse(content) as string) }} /> : <p className="whitespace-pre-wrap break-words text-sm text-neutral-100">{content}</p>}</div>
                    {collapsed && <button type="button" onClick={() => setCollapsedMessages(current => ({ ...current, [key]: false }))} className="mt-1.5 block text-[11px] font-medium text-indigo-400 hover:text-indigo-300">Show more ▾</button>}
                    {!collapsed && Object.prototype.hasOwnProperty.call(collapsedMessages, key) && <button type="button" onClick={() => setCollapsedMessages(current => ({ ...current, [key]: true }))} className="mt-1.5 block text-[11px] font-medium text-indigo-400 hover:text-indigo-300">Show less ▴</button>}
                </article>;
            })}
        </div>
        <div className="border-t border-neutral-800 p-4"><div className="mb-2 flex flex-wrap gap-2"><input value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder="System prompt (optional)" className="min-w-48 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"/><select value={thinking} onChange={event => setThinking(event.target.value)} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"><option value="default">Thinking default</option><option value="on">Thinking on</option><option value="off">Thinking off</option></select><input value={kwargs} onChange={event => setKwargs(event.target.value)} placeholder='extra kwargs JSON' className="w-48 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs"/></div><textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} disabled={streaming || state?.state !== 'ready'} placeholder={state?.state === 'ready' ? 'Message…' : 'Waiting for model…'} rows={3} className="w-full resize-none rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"/><div className="mt-2 flex items-center justify-between"><span className="text-xs text-neutral-500">~{estimateTokens(draft)} tokens</span>{streaming ? <button type="button" onClick={stop} className="rounded bg-red-900 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-800">Stop</button> : <button type="button" onClick={() => { void send(); }} disabled={!draft.trim() || state?.state !== 'ready'} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">Send</button>}</div></div>
        {sessions.length > 0 && <div className="border-t border-neutral-800 p-3"><h3 className="mb-2 text-xs font-semibold text-neutral-500">Chat history</h3><div className="max-h-32 space-y-1 overflow-y-auto">{[...sessions].sort((a, b) => Number(b.id) - Number(a.id)).map(session => <button key={session.id} type="button" onClick={() => { setSessionId(session.id); setMessages(session.messages); setError(null); }} className="block w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-400 hover:bg-neutral-800">{new Date(Number(session.id)).toLocaleString()} · {session.messages.length} msgs</button>)}</div></div>}
    </section>;
}