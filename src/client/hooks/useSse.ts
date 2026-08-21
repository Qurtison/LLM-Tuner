import { useEffect, useRef, useState } from 'react';

type Options = { enabled?: boolean };
export function useSse(path: string, onMessage: (data: string) => void, opts: Options = {}): { lastEventAt: number; connected: boolean } {
  const enabled = opts.enabled ?? true;
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventRef = useRef(0);
  const closeTimerRef = useRef<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    const connect = () => {
      sourceRef.current?.close();
      const source = new EventSource(path); sourceRef.current = source; lastEventRef.current = Date.now();
      source.onopen = () => setConnected(true);
      source.onmessage = (event) => { const now = Date.now(); lastEventRef.current = now; setLastEventAt(now); onMessage(event.data); };
      source.onerror = () => setConnected(false);
    };
    if (!sourceRef.current) connect();
    const watchdog = window.setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastEventRef.current > 45_000) connect(); }, 5_000);
    return () => { window.clearInterval(watchdog); closeTimerRef.current = window.setTimeout(() => { sourceRef.current?.close(); sourceRef.current = null; setConnected(false); closeTimerRef.current = null; }, 100); };
  }, [enabled, onMessage, path]);
  return { lastEventAt, connected };
}
