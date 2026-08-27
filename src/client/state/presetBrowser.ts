/*
 * Open/close state for the preset browser overlay. Mounted once at
 * App root; PresetDock's Browse button and the ⌘K hotkey both call
 * the same store so they stay in sync.
 */
type Listener = () => void;

class Value<T> {
    private value: T;
    private listeners = new Set<Listener>();
    constructor(initial: T) { this.value = initial; }
    get(): T { return this.value; }
    set(next: T): void { if (next === this.value) return; this.value = next; this.listeners.forEach(l => l()); }
    subscribe = (l: Listener): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
}

class PresetBrowserState {
    private value = new Value<{ open: boolean }>({ open: false });
    get = (): { open: boolean } => this.value.get();
    subscribe = this.value.subscribe;
    setOpen(open: boolean): void { this.value.set({ open }); }
    toggle(): void { this.value.set({ open: !this.value.get().open }); }
}

export const presetBrowser = new PresetBrowserState();
