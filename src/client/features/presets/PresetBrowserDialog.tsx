/*
 * Settings browser — full overlay over the app. 860×780, opens on ⌘K
 * and from the dock's "Browse all settings" button. Shows every
 * ParamDef from the registry grouped by ParamGroup; modified rows
 * pinned to the top of each group with an amber left border.
 *
 * ponytail: focus is a single visible "row" index across the visible
 * flat list. ⇥/⇤ jumps between groups. ⌫ resets a row to default.
 * Filter chips: All | Modified | Archive. Search matches label, flags,
 * env var, and help text — case-insensitive substring.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePresets } from '../../hooks/usePresets';
import { useModels } from '../../hooks/useModels';
import { presetBrowser } from '../../state/presetBrowser';
import { ModelSelect } from './ModelSelect';
import {
    LLAMA_PARAMS,
    GROUP_ORDER,
    type ParamDef,
    type ParamGroup,
    type ParamScope,
} from '../../../../shared/llama-params';
import type { LaunchConfig, ModelEntry } from '../../../../shared/contracts';
import { fieldForParamId, overridesFromConfig, intInputValid } from './registry';

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

type Filter = 'all' | 'modified' | 'archive';

interface BrowserRow {
    def: ParamDef;
    modified: boolean;
    currentValue: unknown;
    field: keyof LaunchConfig | null;
}

function searchScore(def: ParamDef, q: string): number {
    if (!q) return 0;
    const needle = q.toLowerCase();
    if (def.label.toLowerCase().includes(needle)) return 3;
    if (def.id.toLowerCase().includes(needle)) return 2;
    if (def.flags.some(f => f.toLowerCase().includes(needle))) return 2;
    if (def.env && def.env.toLowerCase().includes(needle)) return 2;
    if (def.help.toLowerCase().includes(needle)) return 1;
    return 0;
}

function rowKey(def: ParamDef): string {
    return def.id;
}

function fieldForDef(def: ParamDef, draft: LaunchConfig): { field: keyof LaunchConfig | null; value: unknown } {
    // Map via the param registry, NOT draft keys — an unset-but-mapped
    // param (e.g. ctx on a fresh preset) must still write its field.
    const field = fieldForParamId(def.id);
    return { field, value: field ? draft[field] : (draft.paramOverrides?.[def.id]) };
}

interface BrowserDialogProps {
    onClose: () => void;
}

export default function PresetBrowserDialog({ onClose }: BrowserDialogProps) {
    const { draft, setValue, setParam } = usePresets();
    const { models } = useModels();
    const { open } = useSyncExternalStore(presetBrowser.subscribe, presetBrowser.get, presetBrowser.get);
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const [activeGroup, setActiveGroup] = useState<ParamGroup>('sampling');
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);

    const modifiedIds = useMemo(() => {
        const set = new Set<string>();
        for (const o of overridesFromConfig(draft)) set.add(o.def.id);
        return set;
    }, [draft]);

    const groupsWithCounts = useMemo(() => {
        const map = new Map<ParamGroup, { total: number; modified: number }>();
        for (const def of LLAMA_PARAMS) {
            const cur = map.get(def.group) ?? { total: 0, modified: 0 };
            cur.total += 1;
            if (modifiedIds.has(def.id)) cur.modified += 1;
            map.set(def.group, cur);
        }
        return map;
    }, [modifiedIds]);

    const visibleGroups = useMemo(() => {
        if (filter === 'archive') return ['archive' as ParamGroup];
        return GROUP_ORDER.filter(g => g !== 'archive');
    }, [filter]);

    const rowsByGroup = useMemo(() => {
        const m = new Map<ParamGroup, BrowserRow[]>();
        for (const def of LLAMA_PARAMS) {
            if (filter === 'modified' && !modifiedIds.has(def.id)) continue;
            if (filter === 'archive' && def.scope !== 'archive') continue;
            const score = searchScore(def, query);
            if (query && score === 0) continue;
            const list = m.get(def.group) ?? [];
            const { field, value } = fieldForDef(def, draft);
            list.push({ def, modified: modifiedIds.has(def.id), currentValue: value, field });
            m.set(def.group, list);
        }
        for (const list of m.values()) {
            list.sort((a, b) => {
                if (a.modified !== b.modified) return a.modified ? -1 : 1;
                if (query) {
                    const sa = searchScore(a.def, query);
                    const sb = searchScore(b.def, query);
                    if (sa !== sb) return sb - sa;
                }
                return a.def.label.localeCompare(b.def.label);
            });
        }
        return m;
    }, [filter, modifiedIds, query, draft]);

    const currentGroupRows = rowsByGroup.get(activeGroup) ?? [];
    const totalVisible = useMemo(() => {
        let n = 0;
        for (const list of rowsByGroup.values()) n += list.length;
        return n;
    }, [rowsByGroup]);

    useEffect(() => {
        if (!open) return;
        searchRef.current?.focus();
        if (!focusedId && currentGroupRows.length > 0) setFocusedId(currentGroupRows[0].def.id);
    }, [open, currentGroupRows, focusedId]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
            if (event.key === 'Tab') {
                event.preventDefault();
                const idx = visibleGroups.indexOf(activeGroup);
                const dir = event.shiftKey ? -1 : 1;
                const next = visibleGroups[(idx + dir + visibleGroups.length) % visibleGroups.length];
                setActiveGroup(next);
                const first = (rowsByGroup.get(next) ?? [])[0];
                if (first) setFocusedId(first.def.id);
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (currentGroupRows.length === 0) return;
                const idx = currentGroupRows.findIndex(r => r.def.id === focusedId);
                const dir = event.key === 'ArrowDown' ? 1 : -1;
                const next = currentGroupRows[(idx + dir + currentGroupRows.length) % currentGroupRows.length];
                if (next) setFocusedId(next.def.id);
                return;
            }
            if (event.key === 'Backspace' && focusedId) {
                const row = currentGroupRows.find(r => r.def.id === focusedId);
                if (row) {
                    event.preventDefault();
                    if (row.field) setValue(row.field, undefined);
                    else setParam(row.def.id, undefined);
                }
                return;
            }
            if (event.key === 'Enter' && focusedId) {
                const row = currentGroupRows.find(r => r.def.id === focusedId);
                if (row && row.field) {
                    event.preventDefault();
                    const el = document.getElementById('browser-edit-' + row.def.id) as HTMLInputElement | HTMLSelectElement | null;
                    el?.focus();
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, activeGroup, focusedId, currentGroupRows, rowsByGroup, visibleGroups, setValue]);

    if (!open) return null;

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Settings browser"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={onClose}
        >
            <div
                className="flex h-[780px] max-h-[90vh] w-[860px] max-w-[95vw] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 text-neutral-100 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Top bar */}
                <div className="flex items-center gap-2 border-b border-neutral-800 px-5 py-3">
                    <input
                        ref={searchRef}
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="search 248 settings, flags and env vars"
                        className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-amber-500 focus:outline-none"
                    />
                    <div className="flex rounded border border-neutral-700 text-[11px]">
                        {(['all', 'modified', 'archive'] as Filter[]).map(f => (
                            <button
                                key={f}
                                type="button"
                                onClick={() => { setFilter(f); if (f === 'archive') setActiveGroup('archive'); }}
                                className={'px-2.5 py-1 ' + (filter === f ? 'bg-amber-500 text-neutral-950' : 'text-neutral-400 hover:text-neutral-200')}
                            >
                                {f === 'all' ? 'All' : f === 'modified' ? `Modified ${modifiedIds.size}` : `Archive ${groupsWithCounts.get('archive')?.total ?? 0}`}
                            </button>
                        ))}
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close" className="rounded px-2 py-1 text-neutral-400 hover:text-neutral-100">✕</button>
                </div>

                <div className="flex min-h-0 flex-1">
                    {/* Left rail */}
                    <nav aria-label="Categories" className="w-[216px] shrink-0 overflow-y-auto border-r border-neutral-800 py-3">
                        {visibleGroups.map(group => {
                            const counts = groupsWithCounts.get(group);
                            const isActive = group === activeGroup;
                            const isArchive = group === 'archive';
                            return (
                                <div key={group}>
                                    {isArchive && <div className="border-t border-neutral-800" />}
                                    {isArchive && <p className="px-5 py-1.5 text-[10px] uppercase tracking-wider text-neutral-600">deprecated & removed</p>}
                                    <button
                                        type="button"
                                        onClick={() => setActiveGroup(group)}
                                        className={
                                            'flex w-full items-center justify-between px-5 py-2 text-left text-[12.5px] ' +
                                            (isActive ? 'border-l-2 border-amber-500 bg-neutral-900 font-semibold text-neutral-100' : 'border-l-2 border-transparent text-neutral-400 hover:text-neutral-200')
                                        }
                                    >
                                        <span>{GROUP_LABELS[group]}</span>
                                        {counts && counts.modified > 0 && <span className="text-[10.5px] text-amber-500">{counts.modified}</span>}
                                    </button>
                                </div>
                            );
                        })}
                    </nav>

                    {/* Right pane */}
                    <section className="flex-1 overflow-y-auto px-6 py-4">
                        <header className="mb-3">
                            <h2 className="text-base font-semibold text-neutral-100">{GROUP_LABELS[activeGroup]}</h2>
                            <p className="font-mono text-[11px] text-neutral-500">
                                {currentGroupRows.length} setting{currentGroupRows.length === 1 ? '' : 's'}{filter !== 'all' ? ` (${filter})` : ''}
                            </p>
                        </header>
                        {currentGroupRows.length === 0 && (
                            <p className="py-6 text-center text-[12px] text-neutral-500">No settings match.</p>
                        )}
                        <ul className="flex flex-col gap-1.5">
                            {currentGroupRows.map(row => (
                                <BrowserRow
                                    key={rowKey(row.def)}
                                    row={row}
                                    models={models}
                                    isFocused={row.def.id === focusedId}
                                    onFocus={() => setFocusedId(row.def.id)}
                                    onChange={v => (row.field ? setValue(row.field, v as never) : setParam(row.def.id, v))}
                                />
                            ))}
                        </ul>
                    </section>
                </div>

                {/* Footer */}
                <footer className="flex items-center gap-3 border-t border-neutral-800 px-5 py-2 text-[11px] text-neutral-500">
                    <span><kbd className="font-mono">↑↓</kbd> move</span>
                    <span><kbd className="font-mono">⏎</kbd> edit</span>
                    <span><kbd className="font-mono">⌫</kbd> reset to default</span>
                    <span><kbd className="font-mono">⇥</kbd> next group</span>
                    <button type="button" onClick={onClose} className="ml-auto rounded bg-amber-500 px-3 py-1 text-[11px] font-semibold text-neutral-950 hover:bg-amber-400">Done</button>
                </footer>
            </div>
            <p className="sr-only">{totalVisible} settings visible.</p>
        </div>
    );
}

function paramScopeLabel(scope: ParamScope): string {
    if (scope === 'archive') return 'archive';
    if (scope === 'request') return 'request';
    return 'server';
}

function BrowserRow({ row, models, isFocused, onFocus, onChange }: { row: BrowserRow; models: ModelEntry[]; isFocused: boolean; onFocus: () => void; onChange: (value: unknown) => void }) {
    const { def, modified, currentValue, field } = row;
    const isArchive = def.scope === 'archive';
    const disabled = isArchive && currentValue === undefined;
    const [draftVal, setDraftVal] = useState<string | boolean>(() => toInput(currentValue, def.control, def));
    const latest = useRef(draftVal);
    const touched = useRef(false);

    useEffect(() => { setDraftVal(toInput(currentValue, def.control, def)); }, [currentValue, def.control]);
    useEffect(() => { latest.current = draftVal; }, [draftVal]);

    // Commit an explicit raw value: setState in the same tick is async, so
    // parsing draftVal inside the change handler would commit the OLD value.
    const commitRowValue = (raw: string | boolean) => {
        const s = String(raw);
        if (def.control === 'int' && !intInputValid(s)) {
            // decimal/garbage in an int field: revert the input, save nothing
            setDraftVal(toInput(currentValue, def.control));
            return;
        }
        const next = parseInput(raw, def.control);
        if (next === undefined) {
            if (field) onChange(undefined);
        } else {
            onChange(next);
        }
    };
    const commitValue = (raw: string | boolean) => {
        touched.current = true;
        commitRowValue(raw);
    };
    // Typing then leaving the row (category switch, filter, Done) without
    // blurring would drop the edit — commit it on the way out, but only if
    // the user actually typed, or every browsed row would become an
    // "override" of its own current value.
    useEffect(() => () => {
        if (touched.current) commitRowValue(latest.current);
    }, []);
    const trackValue = (v: string | boolean) => {
        if (v !== toInput(currentValue, def.control, def)) touched.current = true;
        setDraftVal(v);
    };

    const baseCls = 'rounded px-3 py-2 ' + (modified ? 'border-l-2 border-amber-500 bg-[#14171e]' : 'border-l-2 border-transparent');
    const focusCls = isFocused ? 'ring-1 ring-amber-500/40 ' : '';

    return (
        <li
            className={baseCls + focusCls + (isArchive ? ' opacity-55' : '')}
            onClick={onFocus}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-neutral-100">{def.label}</span>
                        <span className="font-mono text-[10px] uppercase text-neutral-500">{paramScopeLabel(def.scope)}</span>
                        {isArchive && <span className="rounded bg-orange-900/40 px-1.5 py-0.5 text-[10px] text-orange-400">deprecated</span>}
                    </div>
                    {def.defaultLabel !== undefined && <p className="mt-0.5 font-mono text-[10.5px] text-neutral-500">default {def.defaultLabel}</p>}
                    {def.default !== undefined && def.default !== '' && def.defaultLabel === undefined && <p className="mt-0.5 font-mono text-[10.5px] text-neutral-500">default {String(def.default)}</p>}
                </div>
                <div className="shrink-0">{renderControl(def, draftVal, trackValue, commitValue, disabled, field, models)}</div>
            </div>
        </li>
    );
}

export function toInput(value: unknown, control: string, def?: ParamDef): string | boolean {
    if (control === 'toggle') return Boolean(value);
    if (value === undefined || value === null) {
        // No override: show the effective default so a numeric row never
        // reads as empty. Typing the default back commits as a no-op and
        // the box keeps showing the value instead of clearing.
        if ((control === 'int' || control === 'float') && def && def.default !== undefined) return String(def.default);
        return '';
    }
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
}

function parseInput(raw: string | boolean, control: string): unknown {
    if (control === 'toggle') return Boolean(raw);
    const s = String(raw);
    if (s === '') return undefined;
    if (control === 'int') { const n = Number(s); return Number.isFinite(n) ? Math.trunc(n) : s; }
    if (control === 'float') { const n = Number(s); return Number.isFinite(n) ? n : s; }
    if (control === 'list' || control === 'multi-enum') return s.split(',').map(x => x.trim()).filter(Boolean);
    return s;
}

function renderControl(def: ParamDef, value: string | boolean, setValue: (v: string | boolean) => void, commitValue: (raw: string | boolean) => void, disabled: boolean, _field: keyof LaunchConfig | null, models: ModelEntry[]) {
    const cls = 'rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-100 focus:border-amber-500 focus:outline-none disabled:opacity-50';
    const id = 'browser-edit-' + def.id;
    // Model path: real dropdown of scanned models, not a free-text path.
    if (_field === 'modelPath' && !disabled) {
        return <ModelSelect value={String(value)} models={models} onChange={v => { setValue(v); commitValue(v); }} className={cls + ' w-64 font-mono'} />;
    }
    if (def.control === 'toggle') {
        return <input id={id} type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={e => { setValue(e.target.checked); commitValue(e.target.checked); }} className="h-4 w-4 accent-amber-500" />;
    }
    if (def.control === 'enum' && def.options) {
        return (
            <select id={id} disabled={disabled} value={String(value)} onChange={e => { setValue(e.target.value); commitValue(e.target.value); }} className={cls}>
                {def.options.map(opt => <option key={opt.value} value={opt.value}>{opt.label || opt.value}</option>)}
            </select>
        );
    }
    const type = def.control === 'int' || def.control === 'float' ? 'number' : 'text';
    const step = def.control === 'float' ? 'any' : undefined;
    return (
        <input
            id={id}
            type={type}
            {...(step ? { step } : {})}
            disabled={disabled}
            value={String(value)}
            onChange={e => setValue(e.target.value)}
            onBlur={() => commitValue(value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitValue(value); } }}
            className={cls + ' w-40 font-mono'}
        />
    );
}