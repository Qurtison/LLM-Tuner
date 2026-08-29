import { useEffect, useRef, useState } from 'react';

type Options = { enabled?: boolean };
export function useSse(path: string, onMessage: (data: string) => void, opts: Options = {}): { connected: boolean } {
  const enabled = opts.enabled ?? true;
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventRef = useRef(0);
  const closeTimerRef = useRef<number | null>(null);
  // Ref so onMessage can change without tearing the connection down; a stale
  // closure here used to keep the OLD handler/path wired after every effect
  // re-run (the deferred close skipped the reconnect).
  const onMessageRef = useRef(onMessage);
  const [connected, setConnected] = useState(false);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => {
    if (!enabled) return;
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    const connect = () => {
      sourceRef.current?.close();
      const source = new EventSource(path); sourceRef.current = source; lastEventRef.current = Date.now();
      source.onopen = () => setConnected(true);
      source.onmessage = (event) => { lastEventRef.current = Date.now(); onMessageRef.current(event.data); };
      source.onerror = () => setConnected(false);
    };
    // Always (re)connect: a changed path needs a fresh EventSource even when
    // one is still open from a cancelled deferred close.
    connect();
    const watchdog = window.setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastEventRef.current > 45_000) connect(); }, 5_000);
    return () => { window.clearInterval(watchdog); closeTimerRef.current = window.setTimeout(() => { sourceRef.current?.close(); sourceRef.current = null; setConnected(false); closeTimerRef.current = null; }, 100); };
  }, [enabled, path]);
  return { connected };
}
