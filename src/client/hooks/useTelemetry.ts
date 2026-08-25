import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { getErrorMessage } from '../api/errors';
import type { TelemetryLatestResponse } from '../../../shared/contracts';

export function useTelemetryLatest(intervalMs: number, enabled = true): { latest: TelemetryLatestResponse | null; error: string } {
    const [latest, setLatest] = useState<TelemetryLatestResponse | null>(null);
    const [error, setError] = useState('');
    const inFlight = useRef(false);

    useEffect(() => {
        if (!enabled || intervalMs <= 0) return;
        let alive = true;
        const poll = async () => {
            if (inFlight.current) return;
            inFlight.current = true;
            try {
                const result = await api<TelemetryLatestResponse>('/api/telemetry/latest');
                if (!alive) return;
                setLatest(result);
                setError('');
            } catch (cause) {
                if (!alive) return;
                // OverviewPanel previously silently ignored 5s poll errors; keep
                // visible error for MonitorPanel via caller check, but don't spam.
                setError(getErrorMessage(cause, 'Telemetry request failed.'));
            } finally {
                inFlight.current = false;
            }
        };
        void poll();
        const timer = window.setInterval(() => { void poll(); }, intervalMs);
        return () => { alive = false; window.clearInterval(timer); };
    }, [intervalMs, enabled]);

    return { latest, error };
}
