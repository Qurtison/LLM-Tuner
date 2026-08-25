import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { getErrorMessage } from '../api/errors';
import type { Device, DevicesResponse } from '../../../shared/contracts';

export function useDevices(build: string): { devices: Device[]; error: string } {
    const [devices, setDevices] = useState<Device[]>([]);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!build) { setDevices([]); return; }
        let alive = true;
        api<DevicesResponse>('/api/devices?build=' + encodeURIComponent(build))
            .then(data => {
                if (!alive) return;
                setDevices(data.devices || []);
                if (data.error) setError(data.error);
                else setError('');
            })
            .catch(err => { if (alive) { setDevices([]); setError(getErrorMessage(err, 'Device discovery failed.')); } });
        return () => { alive = false; };
    }, [build]);
    return { devices, error };
}
