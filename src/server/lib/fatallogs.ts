/*
 * Fatal-log detection for the spawned llama-server child.
 *
 * Lines that mean the process is actually dying or unusable. Deliberately NOT
 * "any line containing 'error:' or 'abort'" -- llama-server logs non-fatal
 * client aborts and per-request errors all the time, and the old substring
 * check would have SIGTERM'd a healthy model server over any of them. A
 * process that exits on its own is handled by the 'close' handler.
 */

export const FATAL_LINE_RE = /llama_server: fatal error|segfault|out of memory/i;

// Returns true if a reconstructed llama-server stdout/stderr line indicates
// the child process has died fatally (matches FATAL_LINE_RE).
export function isFatalLogLine(line: string): boolean {
    return FATAL_LINE_RE.test(line);
}

