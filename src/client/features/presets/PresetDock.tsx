/*
 * Right-docked preset inspector. Renders only the LaunchConfig fields
 * the user has changed from the registry default — a preset *is* its
 * diff. Each row click edits in place; ⌫ resets; restart-required
 * rows are tagged. Header pills, dirty dot, save/revert actions.
 *
 * ponytail: no browse-overlay yet (Step 4). Footer button is a stub
 * that calls window.alert so the layout is testable. Inline edit
 * controls cover int/float/enum/multi-enum/toggle/text/path/list.
 * Device-list lists (tensor_split, fit_target) render as comma-joined
 * text for now; wire to `llama-server --list-devices` when the device
 * service lands.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePresets } from '../../hooks/usePresets';
import { useModels } from '../../hooks/useModels';
import { presetBrowser } from '../../state/presetBrowser';
import { GROUP_ORDER, type ParamGroup } from '../../../../shared/llama-params';
import type { LaunchConfig, Preset, ModelEntry } from '../../../../shared/contracts';
import { ModelSelect } from './ModelSelect';
import type { OverrideEntry } from './registry';

const GROUP_LABELS: Record<ParamGroup, string> = {
    speed: 'Speed & threads',
    memory: 'Memory & VRAM',
    context: 'Context & caching',
    sampling: 'Output & sampling',
    model: 'Model & source',
    devices: 'Devices & GPUs',
    speculative: 'Speculative decoding',
    server: 'Server & network',
    agents: 'Agents & tools',
    multimodal: 'Multimodal & embeddings',
    chat: 'Chat & reasoning',
    logging: 'Logging & debug',
    archive: 'Archive',
};

const SCOPE_RESTART_HINT = 'N settings apply on next server start';

const INPUT_CLS = 'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-amber-500 focus:outline-none';

function restartCount(overrides: OverrideEntry[]): number {
    return overrides.reduce((n, o) => n + (o.def.requiresRestart ? 1 : 0), 0);
}

function formatDefault(def: OverrideEntry['def']): string {
    if (def.defaultLabel) return def.defaultLabel;
    if (def.default === undefined || def.default === '') return '';
    return String(def.default);
}

function formatValue(value: unknown): string {
    if (Array.isArray(value)) return value.join(', ');
    if (value === undefined || value === null) return '';
    return String(value);
}

function toInputValue(field: keyof LaunchConfig, value: unknown, control: string): string | boolean {
    if (control === 'toggle') return Boolean(value);
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
}

function parseInput(field: keyof LaunchConfig, raw: string | boolean, control: string): unknown {
    if (control === 'toggle') return Boolean(raw);
    const s = String(raw);
    if (s === '') return undefined;
    if (control === 'int') {
        const n = Number(s);
        return Number.isFinite(n) ? Math.trunc(n) : s;
    }
    if (control === 'float') {
        const n = Number(s);
        return Number.isFinite(n) ? n : s;
    }
    if (control === 'list' || control === 'multi-enum') {
        return s.split(',').map(x => x.trim()).filter(Boolean);
    }
    return s;
}

interface RowProps {
    entry: OverrideEntry;
    onChange: (value: unknown) => void;
    onReset: () => void;
    animating: boolean;
    models: ModelEntry[];
}

function OverrideRow({ entry, onChange, onReset, animating, models }: RowProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<string | boolean>(() => toInputValue(entry.field, entry.value, entry.def.control));
    const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
    const control = entry.def.control;

    useEffect(() => {
        if (editing) {
            if (inputRef.current && 'focus' in inputRef.current) {
                inputRef.current.focus();
                if (inputRef.current instanceof HTMLInputElement && inputRef.current.type !== 'checkbox') inputRef.current.select();
            }
        }
    }, [editing]);

    const commit = () => {
        const next = parseInput(entry.field, draft, control);
        if (next === undefined) onReset();
        else onChange(next);
        setEditing(false);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        else if (event.key === 'Escape') { event.preventDefault(); setDraft(toInputValue(entry.field, entry.value, control)); setEditing(false); }
        else if (event.key === 'Backspace' && !editing) { event.preventDefault(); onReset(); }
    };

    const inputBase = INPUT_CLS;

    const renderControl = () => {
        // modelPath gets a real dropdown of scanned models instead of a
        // free-text path input.
        if (entry.field === 'modelPath') {
            return <ModelSelect value={String(draft)} models={models} onChange={p => (p ? onChange(p) : onReset())} />;
        }
        if (control === 'toggle') {
            return (
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-neutral-200">
                    <input ref={inputRef as React.RefObject<HTMLInputElement>} type="checkbox" checked={Boolean(draft)} onChange={e => setDraft(e.target.checked)} onBlur={commit} className="h-3.5 w-3.5 accent-amber-500" />
                    {String(draft)}
                </label>
            );
        }
        if (control === 'enum' && entry.def.options) {
            return (
                <select ref={inputRef as React.RefObject<HTMLSelectElement>} value={String(draft)} onChange={e => setDraft(e.target.value)} onBlur={commit} className={inputBase}>
                    {entry.def.options.map(opt => <option key={opt.value} value={opt.value}>{opt.label || opt.value}</option>)}
                </select>
            );
        }
        const inputType = control === 'int' || control === 'float' ? 'number' : 'text';
        const step = control === 'float' ? 'any' : undefined;
        return (
            <input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                type={inputType}
                {...(step ? { step } : {})}
                value={String(draft)}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                className={inputBase + ' font-mono'}
            />
        );
    };

    const rowCls = 'group flex flex-col gap-1 border-l-2 border-amber-500 pl-3 pr-3 py-2 transition-all duration-150 ease-out ' + (animating ? ' opacity-0 -translate-y-1 max-h-0 py-0 overflow-hidden' : ' opacity-100 max-h-40');

    return (
        <div className={rowCls} onKeyDown={onKeyDown} tabIndex={0} role="group" aria-label={entry.def.label}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-neutral-100">
                    {entry.def.label}
                    {entry.def.requiresRestart && <span title={SCOPE_RESTART_HINT} aria-label="requires restart" className="ml-1 text-amber-500">↻</span>}
                </span>
                {!editing && (
                    <button type="button" onClick={() => setEditing(true)} className="text-right text-xs text-neutral-200 hover:text-amber-400 focus:outline-none focus:text-amber-400" aria-label={'Edit ' + entry.def.label}>
                        <span className="font-mono">{formatValue(entry.value)}</span>
                    </button>
                )}
            </div>
            {!editing ? (
                <div className="flex items-center gap-2 text-[10.5px] text-neutral-500">
                    {formatDefault(entry.def) && <span className="line-through">{formatDefault(entry.def)}</span>}
                </div>
            ) : (
                <div className="mt-1">{renderControl()}</div>
            )}
        </div>
    );
}

interface PillProps {
    preset: Preset;
    active: boolean;
    onSelect: () => void;
}

function PresetPill({ preset, active, onSelect }: PillProps) {
    const cls = active
        ? 'rounded-full bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-neutral-950'
        : 'rounded-full border border-neutral-700 px-2.5 py-1 text-[11px] font-medium text-neutral-400 hover:border-neutral-500 hover:text-neutral-200';
    return <button type="button" onClick={onSelect} className={cls}>{preset.name}</button>;
}

// Mirrors the server's NAME_RE in src/server/services/presets.ts — names
// become file names there, so validate here before POSTing.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function NewPresetDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<string | null> }) {
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => { inputRef.current?.focus(); }, []);

    const submit = async () => {
        const trimmed = name.trim();
        if (!trimmed) { setError('Name required.'); return; }
        if (!NAME_RE.test(trimmed)) { setError('Letters, digits, . _ - only.'); return; }
        const err = await onCreate(trimmed);
        if (err) setError(err);
        else onClose();
    };

    return (
        <div role="dialog" aria-modal="true" aria-label="New preset" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onKeyDown={e => { if (e.key === 'Escape') onClose(); }} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl">
                <h2 className="text-[13px] font-semibold text-neutral-100">New preset</h2>
                <input
                    ref={inputRef}
                    value={name}
                    onChange={e => { setName(e.target.value); setError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                    placeholder="my-preset"
                    className="mt-3 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 focus:border-amber-500 focus:outline-none"
                />
                {error && <p role="alert" className="mt-2 text-[11px] text-red-400">{error}</p>}
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="rounded px-3 py-1 text-[11px] text-neutral-400 hover:text-neutral-200">Cancel</button>
                    <button type="button" onClick={() => void submit()} className="rounded bg-amber-500 px-3 py-1 text-[11px] font-semibold text-neutral-950 hover:bg-amber-400">Create</button>
                </div>
            </div>
        </div>
    );
}

export default function PresetDock() {
    const { presets, active, draft, isDirty, overrides, error, setValue, revert, save, saveAsNew, setActive } = usePresets();
    const [removing, setRemoving] = useState<Set<string>>(new Set());
    const [creating, setCreating] = useState(false);

    const createPreset = async (name: string): Promise<string | null> => {
        const result = await saveAsNew(name);
        return result.ok ? null : (result.error ?? 'Could not create preset.');
    };

    const byGroup = useMemo(() => {
        const m = new Map<ParamGroup, OverrideEntry[]>();
        for (const o of overrides) {
            if (o.field === 'modelPath') continue; // rendered as its own Model section
            const list = m.get(o.def.group) ?? [];
            list.push(o);
            m.set(o.def.group, list);
        }
        for (const list of m.values()) list.sort((a, b) => a.def.label.localeCompare(b.def.label));
        return m;
    }, [overrides]);
    const modelValue = String(draft.modelPath ?? '');

    const restart = restartCount(overrides);
    const hasPresets = presets.length > 0;
    const { models } = useModels();

    const animatedReset = (field: keyof LaunchConfig) => {
        const key = field as string;
        setRemoving(prev => {
            const next = new Set(prev);
            next.add(key);
            return next;
        });
        window.setTimeout(() => {
            setValue(field, undefined);
            setRemoving(prev => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        }, 140);
    };

    return (
        <aside aria-label="Preset inspector" className="flex h-full w-[380px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-950 text-neutral-100">
            {/* Header */}
            <header className="flex flex-col gap-2 border-b border-neutral-800 px-4 py-3">
                <div className="flex items-center">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.15em] text-neutral-500">Presets</span>
                    <span className="ml-auto text-[11px] text-neutral-500">Manage</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {presets.map(p => <PresetPill key={p.name} preset={p} active={active?.name === p.name} onSelect={() => setActive(p.name)} />)}
                    <button
                        type="button"
                        onClick={() => setCreating(true)}
                        className="rounded-full border border-dashed border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
                        aria-label="Create new preset"
                    >+</button>
                </div>
                <div className="flex items-center gap-2">
                    {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />}
                    <span className="font-mono text-[11px] text-neutral-400">
                        {overrides.length} override{overrides.length === 1 ? '' : 's'}{isDirty ? ' · unsaved' : ''}
                    </span>
                    <div className="ml-auto flex gap-2">
                        {isDirty && <button type="button" onClick={revert} className="text-[11px] text-neutral-400 hover:text-neutral-200">Revert</button>}
                        <button
                            type="button"
                            onClick={() => void save()}
                            disabled={!isDirty || !active}
                            className="rounded bg-amber-500 px-3 py-1 text-[11px] font-semibold text-neutral-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
                        >Save</button>
                    </div>
                </div>
                {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}
            </header>

            {/* Diff list */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
                {!hasPresets ? (
                    <p className="px-2 py-6 text-center text-[12px] text-neutral-500">No presets yet. Press + to create one.</p>
                ) : !active ? (
                    <p className="px-2 py-6 text-center text-[12px] text-neutral-500">Select a preset to inspect.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        <section aria-label="Model">
                            <h3 className="px-2 pb-1.5 pt-1 text-[9.5px] font-semibold uppercase tracking-[0.15em] text-neutral-500">Model</h3>
                            <div className="border-l-2 border-amber-500 py-2 pl-3 pr-3">
                                <ModelSelect value={modelValue} models={models} onChange={p => setValue('modelPath', p || undefined)} />
                                {!modelValue && <p className="mt-1 text-[10.5px] text-neutral-500">No model set for this preset.</p>}
                            </div>
                        </section>
                        {overrides.filter(o => o.field !== 'modelPath').length === 0 && (
                            <p className="px-2 py-6 text-center text-[12px] text-neutral-500">Running llama.cpp defaults.</p>
                        )}
                        {GROUP_ORDER.map(group => {
                            const list = byGroup.get(group);
                            if (!list || list.length === 0) return null;
                            return (
                                <section key={group} aria-label={GROUP_LABELS[group]}>
                                    <h3 className="px-2 pb-1.5 pt-1 text-[9.5px] font-semibold uppercase tracking-[0.15em] text-neutral-500">
                                        {GROUP_LABELS[group]} · {list.length}
                                    </h3>
                                    <div className="flex flex-col">
                                        {list.map(o => (
                                            <OverrideRow
                                                key={o.field as string}
                                                entry={o}
                                                onChange={v => setValue(o.field, v as never)}
                                                onReset={() => animatedReset(o.field)}
                                                animating={removing.has(o.field as string)}
                                                models={models}
                                            />
                                        ))}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Footer */}
            <footer className="flex flex-col gap-2 border-t border-neutral-800 px-4 py-3">
                {restart > 0 && (
                    <p className="text-[11px] text-neutral-500">
                        {restart} setting{restart === 1 ? '' : 's'} {SCOPE_RESTART_HINT}
                    </p>
                )}
                <button
                    type="button"
                    onClick={() => presetBrowser.setOpen(true)}
                    className="flex w-full items-center justify-between rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-[12px] text-neutral-200 hover:border-neutral-500"
                >
                    <span>Browse all 248 settings</span>
                    <span className="font-mono text-[10.5px] text-neutral-500">⌘K</span>
                </button>
            </footer>
            {creating && <NewPresetDialog onClose={() => setCreating(false)} onCreate={createPreset} />}
        </aside>
    );
}
