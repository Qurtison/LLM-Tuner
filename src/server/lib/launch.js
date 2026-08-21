/*
 * ponytail: verbatim extraction for Phase 1 tests; convert to TS in Phase 3.
 *
 * Extracted verbatim from server4.js launch-resolution helpers (lines 374-556):
 *  - toFiniteNumber / toNonEmptyString (pure coercion helpers, also used by
 *    routes; duplicated here verbatim so this module has no server4.js dep)
 *  - buildLlamaArgs
 *  - resolveLaunchCommand
 *  - getLlamaServerBinary / isValidBuild / hostFromRpcTarget
 *
 * Requires tokenize.js for tokenizeCommand (verbatim move).
 * Note: getLlamaServerBinary takes the filtered builds list as an arg now;
 * server4.js still owns the dashboardConfig.llamaServerBuilds state +
 * getLlamaServerBuilds() accessor and filters via isValidBuild before calling.
 */
'use strict';

const { tokenizeCommand } = require('./tokenize');

// Coerce a UI/API value to a finite number, or undefined when it's missing,
// empty, or not numeric. Number.isNaN() alone is NOT sufficient: it doesn't
// coerce, so '' and 'abc' sail through it, and an empty string would emit a
// flag with no value (e.g. `--top-k` "").
function toFiniteNumber(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'boolean') return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

// Coerce to a non-empty trimmed string, or undefined. Preserves "0" (unlike
// `v || undefined`, which would drop a legitimate zero).
function toNonEmptyString(v) {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s.length > 0 ? s : undefined;
}

function buildLlamaArgs(config, { mapModelPath, deviceArgs }) {
    // Validate the required knobs up front so a malformed config fails with a
    // clear message instead of spawning `llama-server -m undefined -c NaN`
    // (a blank ctx/ngl field reaches us as NaN -> JSON null).
    const modelPath = toNonEmptyString(config.modelPath);
    if (!modelPath) throw new Error('modelPath is required');

    const ctx = toFiniteNumber(config.ctx);
    const ngl = toFiniteNumber(config.ngl);
    if (ctx === undefined || ngl === undefined) {
        throw new Error('ctx and ngl must be numbers');
    }

    // Port: the UI has no port field today, but a raw command (or a future UI)
    // may set one -- and the /slots poll + CSV rows depend on this being real.
    const port = toFiniteNumber(toNonEmptyString(config.port) || '8080');
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('port must be an integer between 1 and 65535');
    }

    const args = ['-m', mapModelPath(modelPath),
        '-c', String(ctx), '-ngl', String(ngl),
        '--host', '0.0.0.0', '--port', String(port), '--metrics'];

    if (config.fa) args.push('-fa', 'on');
    const cacheK = toNonEmptyString(config.cacheK);
    if (cacheK) args.push('--cache-type-k', cacheK);
    const cacheV = toNonEmptyString(config.cacheV);
    if (cacheV) args.push('--cache-type-v', cacheV);
    const specType = toNonEmptyString(config.specType);
    if (specType) {
        args.push('--spec-type', specType);
        const specDraftNMax = toFiniteNumber(config.specDraftNMax);
        args.push('--spec-draft-n-max', String(specDraftNMax !== undefined ? specDraftNMax : 2));
        const specDraftNMin = toFiniteNumber(config.specDraftNMin);
        if (specDraftNMin !== undefined) {
            args.push('--spec-draft-n-min', String(specDraftNMin));
        }
        const specDraftModel = toNonEmptyString(config.specDraftModel);
        if (specDraftModel) args.push('--spec-draft-model', specDraftModel);
        const ngramFlagStems = { 'ngram-simple': 'ngram-simple', 'ngram-map-k': 'ngram-map-k', 'ngram-map-k4v': 'ngram-map-k4v' };
        for (const type of specType.split(',').map(s => s.trim())) {
            const stem = ngramFlagStems[type];
            if (!stem) continue;
            const sizeN = toFiniteNumber(config.specNgramSizeN);
            if (sizeN !== undefined) args.push('--spec-' + stem + '-size-n', String(sizeN));
            const sizeM = toFiniteNumber(config.specNgramSizeM);
            if (sizeM !== undefined) args.push('--spec-' + stem + '-size-m', String(sizeM));
            const minHits = toFiniteNumber(config.specNgramMinHits);
            if (minHits !== undefined) args.push('--spec-' + stem + '-min-hits', String(minHits));
        }
        args.push('-np', '1');
    }
    const specDraftNgl = toFiniteNumber(config.specDraftNgl);
    if (specDraftNgl !== undefined) args.push('--spec-draft-ngl', String(specDraftNgl));
    const preserveThinking = !!config.preserveThinking;
    const reasoningPreserve = !!config.reasoningPreserve;
    if (preserveThinking) {
        args.push('--chat-template-kwargs', JSON.stringify({ preserve_thinking: true }));
    }
    if (preserveThinking || reasoningPreserve) {
        args.push('--reasoning-preserve');
    }
    args.push(...deviceArgs);
    const temp = toFiniteNumber(config.temp);
    if (temp !== undefined) args.push('--temp', String(temp));
    const topK = toFiniteNumber(config.topK);
    if (topK !== undefined) args.push('--top-k', String(topK));
    const topP = toFiniteNumber(config.topP);
    if (topP !== undefined) args.push('--top-p', String(topP));
    const minP = toFiniteNumber(config.minP);
    if (minP !== undefined) args.push('--min-p', String(minP));
    const presencePenalty = toFiniteNumber(config.presencePenalty);
    if (presencePenalty !== undefined) args.push('--presence-penalty', String(presencePenalty));
    const repeatPenalty = toFiniteNumber(config.repeatPenalty);
    if (repeatPenalty !== undefined) args.push('--repeat-penalty', String(repeatPenalty));
    const nCpuMoe = toFiniteNumber(config.nCpuMoe);
    if (nCpuMoe !== undefined) args.push('--n-cpu-moe', String(nCpuMoe));
    const chatTemplateFile = toNonEmptyString(config.chatTemplateFile);
    if (config.jinja || chatTemplateFile) args.push('--jinja');
    if (chatTemplateFile) args.push('--chat-template-file', chatTemplateFile);
    const loadMode = toNonEmptyString(config.loadMode);
    if (loadMode) args.push('-lm', loadMode);
    const verbosity = toFiniteNumber(config.verbosity);
    if (verbosity !== undefined) args.push('-lv', String(verbosity));
    const argString = toNonEmptyString(config.argString);
    if (argString) {
        const rawTokens = tokenizeCommand(argString.trim());
        for (let i = 0; i < rawTokens.length; i++) {
            const t = rawTokens[i];
            if (t === '-m' && i + 1 < rawTokens.length) {
                args.push('-m', mapModelPath(rawTokens[++i]));
            } else {
                args.push(t);
            }
        }
    }
    return args;
}

// A build entry is usable only if it carries a non-empty binary path --
// dashboard.config.json is user-editable, and a half-deleted entry must not
// corrupt the build list (see getLlamaServerBinary below).
function isValidBuild(b) {
    return b && typeof b.path === 'string' && b.path.trim().length > 0;
}

// Resolves a build id to its binary path, falling back to the first
// configured build if the id is missing/unknown -- e.g. a saved profile or
// restored launch config from before builds existed (no `build` field at
// all), or a stale id left over after dashboard.config.json was edited to
// remove a build. `builds` is the filtered list to resolve against.
function getLlamaServerBinary(builds, buildId) {
    if (!builds || builds.length === 0) {
        throw new Error('No valid llama-server builds configured');
    }
    const found = buildId ? builds.find(b => b.id === buildId) : null;
    return (found || builds[0]).path;
}

// Extract the bare hostname from an RPC/SSH target like "user@host:22" --
// the RPC port (50052) is appended separately, so a user-supplied :port must
// not survive ("host:22:50052" is not a valid RPC endpoint).
function hostFromRpcTarget(target) {
    const s = String(target || '').trim();
    const withoutUser = s.split('@').pop() || s;
    return withoutUser.split(':')[0];
}

// --- LAUNCH COMMAND RESOLUTION (structured config -> command + args) ---
// Shared by /api/preview-command (which only needs the resolved command/args
// to show the user, never spawns anything) and /api/start's fallback path
// (used when the raw-command box is empty).
//
// The master always launches natively (no Docker) -- a local device split
// (GPU A + GPU B) and an RPC worker are both optional add-ons on top of that,
// not separate launch mechanisms. They're mutually exclusive in practice:
// enabling RPC in the GUI forces GPU B back to "None" (script.js
// applyRpcToggleUI), so at most one of localSplit/config.rpcTarget is ever
// true below -- this only supports a 2-way split (this machine vs. one other
// target), not a 3-way local-A + local-B + worker split.
function resolveLaunchCommand(config, builds) {
    const command = getLlamaServerBinary(builds, config.build);
    const mapModelPath = (p) => p; // raw host path, no container mount to remap into
    const deviceArgs = [];
    const localSplit = !!(config.deviceA && config.deviceB && config.deviceA !== config.deviceB);
    const rpcTarget = toNonEmptyString(config.rpcTarget);
    if (localSplit || rpcTarget) {
        deviceArgs.push('--split-mode', 'layer');
        if (localSplit) deviceArgs.push('-dev', config.deviceA + ',' + config.deviceB);
        if (rpcTarget) deviceArgs.push('--rpc', hostFromRpcTarget(rpcTarget) + ':50052');
        const tensorSplit = toFiniteNumber(config.tensorSplit);
        if (tensorSplit !== undefined && tensorSplit >= 0 && tensorSplit < 100) {
            deviceArgs.push('-ts', tensorSplit + ',' + (100 - tensorSplit));
        }
    }

    const args = buildLlamaArgs(config, { mapModelPath, deviceArgs });
    return { command, args };
}

module.exports = {
    toFiniteNumber,
    toNonEmptyString,
    isValidBuild,
    getLlamaServerBinary,
    hostFromRpcTarget,
    buildLlamaArgs,
    resolveLaunchCommand,
};
