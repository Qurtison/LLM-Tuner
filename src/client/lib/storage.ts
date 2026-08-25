export function loadJson<T>(key: string, fallback: T): T {
    try {
        const raw = window.localStorage.getItem(key);
        if (raw == null) return fallback;
        const value: unknown = JSON.parse(raw);
        return value as T;
    } catch {
        return fallback;
    }
}

export function saveJson(key: string, value: unknown): void {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // quota exceeded or unavailable — keep UI usable
    }
}

export function removeJson(key: string): void {
    try {
        window.localStorage.removeItem(key);
    } catch {
        // ignore
    }
}
