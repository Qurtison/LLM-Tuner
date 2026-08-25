// Shared number formatters — single source for "—" placeholder + fixed digits.
export const DASH = '—';

export function fmt(value: number | null | undefined, digits = 1): string {
    return value == null || !Number.isFinite(value) ? DASH : value.toFixed(digits);
}

export function fmtWithUnit(value: number | null | undefined, unit: string, digits?: number): string {
    if (value == null || !Number.isFinite(value)) return DASH + (unit ? ' ' + unit : '');
    const d = digits ?? (unit === '%' ? 0 : 1);
    return value.toFixed(d) + (unit ? ' ' + unit : '');
}

// Draft column formatter used by LiveRequestsPanel / HistoryPanel
export function fmtDraft(row: { draftAcceptRate: number | null | undefined; draftAccepted: number | null | undefined; draftGenerated: number | null | undefined; draftMeanLen: number | null | undefined }): string {
    if (row.draftAcceptRate == null) return DASH;
    return (row.draftAcceptRate * 100).toFixed(0) + '% / ' + (row.draftAccepted ?? '?') + '/' + (row.draftGenerated ?? '?') + ' / ' + fmt(row.draftMeanLen, 2);
}
