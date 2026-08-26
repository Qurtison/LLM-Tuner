import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { getErrorMessage } from '../api/errors';
import type { ModelEntry } from '../../../shared/contracts';

export function useModels(): { models: ModelEntry[]; error: string } {
    const [models, setModels] = useState<ModelEntry[]>([]);
    const [error, setError] = useState('');
    useEffect(() => {
        let alive = true;
        api<ModelEntry[]>('/api/models')
            .then(data => { if (alive) { setModels(Array.isArray(data) ? data : []); setError(''); } })
            .catch(err => { if (alive) setError(getErrorMessage(err, 'Failed to load models.')); });
        return () => { alive = false; };
    }, []);
    return { models, error };
}
