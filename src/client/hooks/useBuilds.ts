import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { getErrorMessage } from '../api/errors';
import type { BuildEntry, BuildsResponse } from '../../../shared/contracts';

export function useBuilds(): { builds: BuildEntry[]; error: string } {
    const [builds, setBuilds] = useState<BuildEntry[]>([]);
    const [error, setError] = useState('');
    useEffect(() => {
        let alive = true;
        api<BuildsResponse>('/api/builds')
            .then(data => { if (alive) { setBuilds(data.builds || []); setError(''); } })
            .catch(err => { if (alive) setError(getErrorMessage(err, 'Failed to load builds.')); });
        return () => { alive = false; };
    }, []);
    return { builds, error };
}
