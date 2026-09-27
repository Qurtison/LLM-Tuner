/*
 * llama-server log-line parsing, extracted from LlamaService.handleLine.
 *
 * Every function here is pure: a line of stdout/stderr (native mode) or a
 * journalctl line (systemd mode) goes in, zero or more typed events come out.
 * The service owns all state; this module owns the regexes and the ordering
 * rules between them.
 *
 * Order matters and mirrors the original if/else chain: a line is classified
 * by the FIRST pattern it matches. The one exception is `print_timing:`, which
 * carries both a generation-progress broadcast and a per-task timing segment
 * on the same line, so it can yield two events.
 *
 * SSE frame strings are built here rather than in the service so the wire
 * format (PREFILL_PROGRESS:<progress>:<rate>:<tokens>) is pinned by unit tests
 * instead of only observable from a live launch.
 */

import { SseLogPrefixes } from '../../../shared/contracts';
import { isFatalLogLine } from './fatallogs';

// Patch applied to a task's accumulated timings for one `prompt eval time` /
// `eval time` segment. Both variants merge over the existing entry.
export type TimingPatch = {
    promptMs?: number;
    promptTokens?: number;
    promptTps?: number;
    genMs?: number;
    genTokens?: number;
    genTps?: number;
};

export type DraftPatch = {
    draftAcceptRate: number;
    draftAccepted: number;
    draftGenerated: number;
    draftMeanLen: number | null;
};

export type LogEvent =
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'task-start' }
    | { kind: 'prefill'; prefillTps?: number; prefillProgress: number; prefillTokens?: number; frame: string }
    | { kind: 'gen'; genTps?: number; genTokens?: number; frame: string }
    | { kind: 'task-timing'; taskId: string; patch: TimingPatch }
    | { kind: 'task-total'; taskId: string; wallTimeS?: string }
    | { kind: 'task-draft'; taskId: string; patch: DraftPatch }
    | { kind: 'task-aborted'; taskId: string }
    | { kind: 'fatal'; message: string };

const PREFILL_PROGRESS_MARKER = 'prompt processing, n_tokens =';
const PRINT_TIMING_MARKER = 'print_timing:';
const STOP_PROCESSING_MARKER = 'stop processing: n_tokens =';

const GEN_TOKENS_RE = /n_gen\s*=\s*(\d+)/;
const DECODED_TOKENS_RE = /n_decoded\s*=\s*(\d+)/;
const TG_3S_RE = /tg_3s\s*=\s*(\d+\.?\d*)\s*t\/s/;
const TG_RE = /tg\s*=\s*(\d+\.?\d*)\s*t\/s/;
const PREFILL_TOKENS_RE = /n_tokens =\s*(\d+)/;
const PREFILL_PROGRESS_RE = /progress = (0\.\d+|1\.00)/;
const PREFILL_TPS_RE = /(\d+\.?\d*)\s*tokens per second/;
const ID_TASK_RE = /id\s+(\d+)\s*\|\s*task\s+(\d+)/;
const TIMING_TOKENS_RE = /=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/;
const TOTAL_TIME_RE = /=\s*([\d.]+)\s*ms/;
const DRAFT_RE = /=\s*([\d.]+)\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\s*\)(?:\s*,\s*mean len\s*=\s*([\d.]+))?/;
const STOP_TASK_RE = /task\s+(\d+)/;

// Broadcast text for a fatal line. 'failed to fit params' is the one llama
// message worth translating -- the rest is passed through, tail-truncated.
export function fatalMessage(line: string): string {
    return line.includes('failed to fit params')
        ? 'Failed to allocate VRAM: Reduce n_gpu_layers or use a smaller model.'
        : 'Process error: ' + line.trim().slice(-200);
}

// A `prompt processing` line without a `progress =` figure carries nothing.
function prefillEvent(line: string): LogEvent | null {
    const progress = line.match(PREFILL_PROGRESS_RE);
    if (!progress) return null;
    const tokens = line.match(PREFILL_TOKENS_RE);
    const tps = line.match(PREFILL_TPS_RE);
    const tokenCount = tokens ? tokens[1] : '0';
    const rate = tps ? tps[1] : '0';
    return {
        kind: 'prefill',
        prefillTps: parseFloat(rate) || undefined,
        prefillProgress: parseFloat(progress[1]),
        prefillTokens: parseInt(tokenCount, 10) || undefined,
        frame: SseLogPrefixes.PREFILL_PROGRESS + ':' + progress[1] + ':' + rate + ':' + tokenCount,
    };
}

// Generation progress needs both a token count and a rolling rate; either one
// alone is a partial line and is ignored.
function genEvent(line: string): LogEvent | null {
    const generated = line.match(GEN_TOKENS_RE) || line.match(DECODED_TOKENS_RE);
    const rate = line.match(TG_3S_RE) || line.match(TG_RE);
    if (!generated || !rate) return null;
    return {
        kind: 'gen',
        genTps: parseFloat(rate[1]) || undefined,
        genTokens: parseInt(generated[1], 10) || undefined,
        frame: SseLogPrefixes.GEN_PROGRESS + ':' + rate[1] + ':' + generated[1],
    };
}

// The '|'-suffixed timing segment of a print_timing line: which task it belongs
// to and what it reports. Empty when the line has no id/task pair or the
// segment is one this parser does not track.
function timingEvents(line: string): LogEvent[] {
    const idTask = line.match(ID_TASK_RE);
    if (!idTask) return [];
    const taskId = idTask[2];
    const segments = line.split('|');
    const segment = segments[segments.length - 1].trim();

    if (segment.startsWith('prompt eval time') || segment.startsWith('eval time')) {
        const m = segment.match(TIMING_TOKENS_RE);
        if (!m) return [];
        const patch: TimingPatch = segment.startsWith('prompt')
            ? { promptMs: parseFloat(m[1]), promptTokens: parseInt(m[2], 10), promptTps: parseFloat(m[3]) }
            : { genMs: parseFloat(m[1]), genTokens: parseInt(m[2], 10), genTps: parseFloat(m[3]) };
        return [{ kind: 'task-timing', taskId, patch }];
    }

    if (segment.startsWith('total time')) {
        const m = segment.match(TOTAL_TIME_RE);
        // The entry is dropped either way: an unparseable total still ends the
        // task, matching the original delete-before-check order.
        return [{ kind: 'task-total', taskId, wallTimeS: m ? (parseFloat(m[1]) / 1000).toFixed(2) : undefined }];
    }

    if (segment.startsWith('draft acceptance')) {
        const m = segment.match(DRAFT_RE);
        if (!m) return [];
        return [{
            kind: 'task-draft',
            taskId,
            patch: {
                draftAcceptRate: parseFloat(m[1]),
                draftAccepted: parseInt(m[2], 10),
                draftGenerated: parseInt(m[3], 10),
                draftMeanLen: m[4] != null ? parseFloat(m[4]) : null,
            },
        }];
    }

    return [];
}

// Classify one llama-server log line into the events it carries.
export function parseLogLine(line: string): LogEvent[] {
    if (line.includes('load_model: loading model')) return [{ kind: 'loading' }];
    if (line.includes('llama_server: model loaded')) return [{ kind: 'ready' }];
    if (line.includes('launch_slot_:') && line.includes('processing task')) return [{ kind: 'task-start' }];

    if (line.includes(PREFILL_PROGRESS_MARKER)) {
        const event = prefillEvent(line);
        return event ? [event] : [];
    }

    if (line.includes(PRINT_TIMING_MARKER)) {
        const gen = genEvent(line);
        const timing = timingEvents(line);
        return gen ? [gen, ...timing] : timing;
    }

    if (line.includes(STOP_PROCESSING_MARKER)) {
        const m = line.match(STOP_TASK_RE);
        return m ? [{ kind: 'task-aborted', taskId: m[1] }] : [];
    }

    if (isFatalLogLine(line)) return [{ kind: 'fatal', message: fatalMessage(line) }];

    return [];
}
