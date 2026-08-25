// Live llama-server console: one long-lived EventSource re-tails the ring
// buffer then follows every new line (/api/master/logs/stream) — same
// tail-and-follow shape as the old dashboard's journal pane, pointed at our
// in-memory capture instead of journald. Auto-reconnects with a fresh tail so
// a dashboard restart never leaves the pane dead.
import { useEffect, useRef, useState } from 'react';

const MAX_LINES = 1000;

export default function LogsPanel() {
    const [lines, setLines] = useState<string[]>([]);
    const [live, setLive] = useState(false);
    const [paused, setPaused] = useState(false);
    const pausedRef = useRef(paused);
    const boxRef = useRef<HTMLPreElement>(null);
    const stick = useRef(true);

    useEffect(() => { pausedRef.current = paused; }, [paused]);

    useEffect(() => {
        let source: EventSource | null = null;
        let retry: number | undefined;
        const connect = () => {
            setLines([]);
            source = new EventSource('/api/master/logs/stream?lines=300');
            source.onopen = () => setLive(true);
            source.onmessage = event => {
                // Pause drops lines rather than buffering them: the point is
                // reading a stable window, not replaying a flood afterwards.
                if (pausedRef.current || !event.data) return;
                setLines(old => [...old, event.data as string].slice(-MAX_LINES));
            };
            source.onerror = () => {
                setLive(false);
                source?.close();
                source = null;
                retry = window.setTimeout(connect, 3000);
            };
        };
        connect();
        return () => { if (retry) window.clearTimeout(retry); source?.close(); };
    }, []);

    useEffect(() => {
        const box = boxRef.current;
        if (box && stick.current) box.scrollTop = box.scrollHeight;
    }, [lines]);

    const onScroll = () => {
        const box = boxRef.current;
        if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    };

    const btn = 'rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-40';
    return (
        <section className="rounded border border-neutral-800 bg-neutral-900" aria-label="Server logs">
            <div className="flex items-center gap-2 px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300">llama-server logs</h3>
                <span title={live ? 'Streaming live' : 'Reconnecting…'} className={'h-1.5 w-1.5 rounded-full ' + (live ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse')} />
                <div className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={() => setPaused(p => !p)} aria-pressed={paused} className={btn}>{paused ? 'Resume' : 'Pause'}</button>
                    <button type="button" onClick={() => setLines([])} disabled={lines.length === 0} className={btn}>Clear</button>
                </div>
            </div>
            <pre ref={boxRef} onScroll={onScroll} className="max-h-80 overflow-auto border-t border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap select-text text-neutral-400">
                {lines.length === 0 ? <span className="text-neutral-600">No log lines yet — start a launch.</span> : lines.join('\n')}
            </pre>
        </section>
    );
}
