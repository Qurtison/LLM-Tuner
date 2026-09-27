import type { ParamDef } from '../../../../shared/llama-params';

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
