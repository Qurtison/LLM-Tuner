/*
 * Minimal external-store cell: one value + subscribe. The single shared
 * implementation for every module-level UI store (server snapshot, presets,
 * panels, preset browser, launch form).
 */
type Listener = () => void;

export class Value<T> {
    private value: T;
    private listeners = new Set<Listener>();
    constructor(initial: T) { this.value = initial; }
    get(): T { return this.value; }
    set(next: T): void { if (next === this.value) return; this.value = next; this.listeners.forEach(l => l()); }
    update(fn: (current: T) => T): void { this.set(fn(this.value)); }
    subscribe = (l: Listener): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
}
