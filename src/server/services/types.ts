import type { DashboardConfig } from '../config';
import type { LaunchConfig } from '../../../shared/contracts';

export interface ServerState {
    serverState: 'stopped' | 'loading' | 'ready' | 'starting' | 'stopping';
    currentModel: string;
    isRpc: boolean;
    loadStartTime: number;
    // string after the first successful load (toFixed) — frozen quirk of
    // the original server; CSV/load-time consumers expect the raw value.
    finalLoadTime: number | string;
    currentLaunchCommand: string;
    currentLaunchConfig: LaunchConfig | null;
}

export interface ServerCtx {
    config: DashboardConfig;
    state: ServerState;
    broadcast: (log?: string, error?: string) => void;
}

export interface TelemetryStats {
    master?: Record<string, number | null>;
    worker?: Record<string, number | null> | null;
}
