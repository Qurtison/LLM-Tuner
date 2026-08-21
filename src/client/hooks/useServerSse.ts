// The single SSE owner for the whole app (Phase 5 slice 1). Every feature
// panel reads state via useServer(); none opens its own EventSource.
import { api } from '../api/client';
import { setServerConfig } from '../state/server';
import type { ConfigResponse } from '../../../shared/contracts';

export function useServerConfig(): void {
    // Config fetch is the only non-SSE boot request (frozen boot order).
    useEffectOnce();
}

import { useEffect } from 'react';
function useEffectOnce(): void {
    useEffect(() => {
        api<ConfigResponse>('/api/config').then(setServerConfig).catch(() => { /* banner shows config absent */ });
    }, []);
}
