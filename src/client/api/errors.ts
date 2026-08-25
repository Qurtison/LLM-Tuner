import { ApiError } from './client';

export function getErrorMessage(error: unknown, fallback = 'Request failed.'): string {
    if (error instanceof ApiError) return error.message || fallback;
    if (error instanceof Error) return error.message || fallback;
    return String(error) || fallback;
}

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

// Chat-specific 502 helper — model not launched
export function getChatErrorMessage(error: unknown): string {
    if (error instanceof ApiError) return error.status === 502 ? 'Model not launched. Start model, then retry.' : error.message || 'Request failed.';
    if (isAbortError(error)) return 'Generation stopped.';
    return error instanceof Error ? error.message : 'Request failed.';
}
