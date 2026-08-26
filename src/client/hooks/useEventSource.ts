import { useEffect, useRef, useState } from 'react';

export function useEventSource(
    path: string | null,
    onMessage: (data: string) => void,
    opts: { enabled?: boolean; retryMs?: number } = {},
): { live: boolean } {
    const enabled = opts.enabled ?? true;
    const retryMs = opts.retryMs ?? 3000;
    const [live, setLive] = useState(false);
    const onMessageRef = useRef(onMessage);
    useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);

    useEffect(() => {
        if (!enabled || !path) { setLive(false); return; }
        let source: EventSource | null = null;
        let retry: number | undefined;
        let alive = true;
        const connect = () => {
            if (!alive) return;
            source?.close();
            source = new EventSource(path);
            source.onopen = () => { if (alive) setLive(true); };
            source.onmessage = event => { if (alive && event.data != null) onMessageRef.current(event.data as string); };
            source.onerror = () => {
                if (!alive) return;
                setLive(false);
                source?.close();
                source = null;
                retry = window.setTimeout(connect, retryMs);
            };
        };
        connect();
        return () => {
            alive = false;
            if (retry != null) window.clearTimeout(retry);
            source?.close();
            setLive(false);
        };
    }, [path, enabled, retryMs]);

    return { live };
}
