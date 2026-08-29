import type { DashboardConfig } from '../config';
import type { LaunchConfig, ServerState as ServerStateValue } from '../../../shared/contracts';

// The state *value* union lives in shared/contracts.ts (single source of
// truth, same type the SSE payload and client parse); this interface is the
// server's shared mutable state object.
export interface ServerState {
    serverState: ServerStateValue;
    currentModel: string;
    isRpc: boolean;
    loadStartTime: number;
    // Seconds to one decimal; 0 until the first successful load completes.
    finalLoadTime: number;
    currentLaunchCommand: string;
    currentLaunchConfig: LaunchConfig | null;
}

export interface ServerCtx {
    config: DashboardConfig;
    state: ServerState;
    broadcast: (log?: string, error?: string) => void;
    // Repo root; optional so existing constructions stay valid. Used by
    // LlamaService for generated/launch.sh + last-launch.json locations.
    appRoot?: string;
}

export interface TelemetryStats {
    master?: Record<string, number | null>;
    worker?: Record<string, number | null> | null;
}
