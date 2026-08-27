/*
 * ponytail: verbatim extraction for Phase 1 tests; convert to TS in Phase 3.
 *
 * Extracted verbatim from server4.js fatal-log detection (line 616 regex +
 * the `FATAL_LINE_RE.test(line)` decision at line 840 inside spawnLlamaProcess's
 * handleLogs). Exposes a pure predicate so the server's log handler can call
 * isFatalLogLine(line) instead of testing the regex inline.
 */
'use strict';

// --- SHARED PROCESS SPAWN + LIFECYCLE ---
// Lines that mean the process is actually dying or unusable. Deliberately NOT
// "any line containing 'error:' or 'abort'" -- llama-server logs non-fatal
// client aborts and per-request errors all the time, and the old substring
// check would have SIGTERM'd a healthy model server over any of them. A
// process that exits on its own is handled by the 'close' handler below.
const FATAL_LINE_RE = /llama_server: fatal error|segfault|out of memory/i;

// Returns true if a reconstructed llama-server stdout/stderr line indicates
// the child process has died fatally (matches FATAL_LINE_RE). Verbatim from
// the `FATAL_LINE_RE.test(line)` check at the fatal branch in spawnLlamaProcess.
function isFatalLogLine(line) {
    return FATAL_LINE_RE.test(line);
}

module.exports = { FATAL_LINE_RE, isFatalLogLine };
