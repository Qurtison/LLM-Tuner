import { useEffect, useSyncExternalStore } from 'react';
import { presetsStore, type PresetsSnapshot } from '../state/presets';
import type { LaunchConfig, Preset } from '../../../shared/contracts';
import type { OverrideEntry } from '../features/presets/registry';
import { overridesFromConfig } from '../features/presets/registry';

export interface UsePresets {
    presets: Preset[];
    active: Preset | null;
    draft: LaunchConfig;
    isDirty: boolean;
    loading: boolean;
    error: string;
    overrides: OverrideEntry[];
    setValue: <K extends keyof LaunchConfig>(field: K, value: LaunchConfig[K]) => void;
    revert: () => void;
    refresh: () => Promise<void>;
    setActive: (name: string | null) => void;
    save: () => Promise<{ ok: boolean; warnings: string[] }>;
    saveAsNew: (name: string) => Promise<{ ok: boolean; warnings: string[]; error?: string }>;
    remove: (name: string) => Promise<boolean>;
}

export function usePresets(): UsePresets {
    const snapshot: PresetsSnapshot = useSyncExternalStore(presetsStore.subscribe, presetsStore.get, presetsStore.get);

    useEffect(() => {
        void presetsStore.refresh();
    }, []);

    return {
        presets: snapshot.presets,
        active: snapshot.active,
        draft: snapshot.draft,
        isDirty: snapshot.isDirty,
        loading: snapshot.loading,
        error: snapshot.error,
        overrides: overridesFromConfig(snapshot.draft),
        setValue: (field, value) => presetsStore.setValue(field, value),
        revert: () => presetsStore.revert(),
        refresh: () => presetsStore.refresh(),
        setActive: (name) => presetsStore.setActive(name),
        save: () => presetsStore.save(),
        saveAsNew: (name) => presetsStore.saveAsNew(name),
        remove: (name) => presetsStore.remove(name),
    };
}
