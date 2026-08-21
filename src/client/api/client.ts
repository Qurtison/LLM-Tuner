export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = 'ApiError'; this.status = status; }
}

export async function api<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.method?.toUpperCase() === 'POST' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    let body: { error?: string } = {};
    try { body = JSON.parse(text); } catch { /* Preserve non-JSON error text. */ }
    throw new ApiError(response.status, body.error || text);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
