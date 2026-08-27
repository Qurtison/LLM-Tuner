/*
 * RpcWorker panel: enable RPC, pick GPU A/B for the worker (if local),
 * set the worker SSH target and transport. Lives outside the LaunchBar
 * because it's rarely touched once configured.
 */
import { fieldClass, useLaunchForm } from '../../components/launchForm';
import { useServer } from '../../state/server';
import WorkerPanel from './WorkerPanel';

export default function RpcWorkerPanel() {
    const { state } = useServer();
    const { form, set, devices, actionError } = useLaunchForm();
    const locked = state?.state !== undefined && state.state !== 'stopped';
    const enabled = Boolean(form.rpcTarget);
    return (
        <div className="space-y-2 text-xs">
            {actionError && <p role="alert" className="text-[11px] text-red-400">{actionError}</p>}
            <fieldset disabled={locked} className="space-y-2 disabled:opacity-50">
                <label className="flex items-center gap-2 text-neutral-200">
                    <input type="checkbox" checked={enabled} onChange={e => set('rpcTarget', e.target.checked ? 'enabled' : '')} className="h-3.5 w-3.5 accent-amber-500" />
                    Enable RPC Worker
                </label>
                {enabled && (
                    <>
                        <div className="grid grid-cols-2 gap-2">
                            <label className="text-neutral-400">GPU A
                                <select value={form.deviceA} onChange={e => set('deviceA', e.target.value)} className={fieldClass}>
                                    <option value="">None</option>
                                    {devices.map(d => <option key={d.id} value={d.id}>{d.id} — {d.description}</option>)}
                                </select>
                            </label>
                            <label className="text-neutral-400">GPU B
                                <select value={form.deviceB} onChange={e => set('deviceB', e.target.value)} className={fieldClass}>
                                    <option value="">None</option>
                                    {devices.map(d => <option key={d.id} value={d.id}>{d.id} — {d.description}</option>)}
                                </select>
                            </label>
                        </div>
                        <label className="block text-neutral-400">Worker SSH
                            <input value={form.workerSsh} onChange={e => set('workerSsh', e.target.value)} placeholder="user@host" className={fieldClass} />
                        </label>
                        <label className="block text-neutral-400">Transport
                            <select value={form.transport} onChange={e => set('transport', e.target.value)} className={fieldClass}>
                                <option value="WiFi">Wi-Fi / LAN</option>
                                <option value="TB4">Thunderbolt 4</option>
                            </select>
                        </label>
                    </>
                )}
            </fieldset>
            <WorkerPanel />
        </div>
    );
}
