/*
 * Open/close state for the preset browser overlay. Mounted once at
 * App root; PresetDock's Browse button and the ⌘K hotkey both call
 * the same store so they stay in sync.
 */
import { Value } from './value';

class PresetBrowserState {
    private value = new Value<{ open: boolean }>({ open: false });
    get = (): { open: boolean } => this.value.get();
    subscribe = this.value.subscribe;
    setOpen(open: boolean): void { this.value.set({ open }); }
}

export const presetBrowser = new PresetBrowserState();
