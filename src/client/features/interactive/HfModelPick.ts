const eventName = 'hf-model-picked';

export function pickHfModel(repo: string): void {
    window.dispatchEvent(new CustomEvent<string>(eventName, { detail: repo }));
}

// Launch panel may subscribe when it mounts; event replaces legacy global DOM coupling.
export function onHfModelPick(listener: (repo: string) => void): () => void {
    const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
}
