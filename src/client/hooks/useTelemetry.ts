import { useEffect, useRef, useState } from 'react';
import { useEventSource } from './useEventSource';
import type { TelemetryLatestResponse } from '../../../shared/contracts';

// One EventSource per consumer (App GpuRow + MonitorPanel). The server
// pushes every sample at its own poll rate (POST /api/telemetry/rate still
// controls the server-side sampling interval), so the client no longer keeps
// a poll timer. The error only appears after a once-live stream drops.
export function useTelemetryLatest(opts: { enabled?: boolean } = {}): { latest: TelemetryLatestResponse | null; error: string } {
    const enabled = opts.enabled ?? true;
    const [latest, setLatest] = useState<TelemetryLatestResponse | null>(null);
    const [error, setError] = useState('');
    const wasLive = useRef(false);
    const onMessage = (data: string) => {
        try {
            setLatest(JSON.parse(data) as TelemetryLatestResponse);
            setError('');
        } catch {
            setError('Bad telemetry frame.');
        }
    };
    const { live } = useEventSource(enabled ? '/api/telemetry/stream' : null, onMessage);
    useEffect(() => {
        if (live) { wasLive.current = true; setError(''); }
        else if (wasLive.current) setError('Telemetry stream disconnected. Reconnecting…');
    }, [live]);
    return { latest, error };
}
