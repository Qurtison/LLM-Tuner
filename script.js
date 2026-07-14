// --- Globals & Utils ---
let abortController = null;
const escapeHtml = (unsafe) => unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Safe formatting helpers -- avoid NaN/Infinity leaking into % widths or "0%" masquerading as real data
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function fmtPct(value, decimals = 1) { return isNum(value) ? `${value.toFixed(decimals)}%` : '--%'; }
function fmtUnit(value, unit, decimals = 0) { return isNum(value) ? `${value.toFixed(decimals)}${unit}` : `--${unit}`; }
function safeRatioPct(numerator, denominator) {
    if (!isNum(numerator) || !isNum(denominator) || denominator <= 0) return 0;
    const pct = (numerator / denominator) * 100;
    return isNum(pct) ? Math.max(0, Math.min(pct, 100)) : 0;
}

// --- SSE log/error hooks (kept intentionally lightweight; the real
// user-facing error surface is the chat-box error bubble in the
// 'stopped' state handler below) ---
function displayErrorInUI(err) { console.error('[llama-server error]', err); }
function appendLogToUI(log) { console.debug('[llama-server log]', log); }

let tpsHistory = []; let netHistory = [];
let tpsChart = null; let netChart = null;
let lastNetBytes = 0;

// Base VRAM trackers
let isModelLoaded = false;
let masterBaseVram = 0;

// Active Session Trackers for CSV
let sessionData = {};

// --- Chat History Tracking ---
let allChatSessions = [];
let currentSessionId = Date.now().toString();
let currentContextLimit = 110000; 
let currentContextTokens = 0;
let runningAverages = {
    prefillSpeedSum: 0,
    prefillSpeedCount: 0,
    genSpeedSum: 0,
    genSpeedCount: 0
};

function updateAverageUI() {
    if (runningAverages.prefillSpeedCount > 0) {
        const avgPrefill = (runningAverages.prefillSpeedSum / runningAverages.prefillSpeedCount).toFixed(1);
        document.getElementById('metric-prefill-avg').innerText = `${avgPrefill} t/s`;
    }
    if (runningAverages.genSpeedCount > 0) {
        const avgGen = (runningAverages.genSpeedSum / runningAverages.genSpeedCount).toFixed(1);
        document.getElementById('metric-gen-avg').innerText = `${avgGen} t/s`;
    }
}

// Load averages from localStorage
try {
    const savedAverages = localStorage.getItem('cluster_averages');
    if (savedAverages) {
        runningAverages = JSON.parse(savedAverages);
        setTimeout(updateAverageUI, 100);
    }
} catch (e) {}

function saveMetricsToAverages(prefillSpeed, genSpeed) {
    const pSpeed = parseFloat(prefillSpeed);
    const gSpeed = parseFloat(genSpeed);
    if (!isNaN(pSpeed) && pSpeed > 0) {
        runningAverages.prefillSpeedSum += pSpeed;
        runningAverages.prefillSpeedCount += 1;
    }
    if (!isNaN(gSpeed) && gSpeed > 0) {
        runningAverages.genSpeedSum += gSpeed;
        runningAverages.genSpeedCount += 1;
    }
    try {
        localStorage.setItem('cluster_averages', JSON.stringify(runningAverages));
    } catch (e) {}
    updateAverageUI();
}

function updateContextUI(currentUsed, limit) {
    const limitVal = parseInt(limit) || 32768;
    document.getElementById('context-tokens-text').innerText = `${currentUsed.toLocaleString()} / ${limitVal.toLocaleString()}`;
    document.getElementById('context-limit-text').innerText = `Limit: ${limitVal.toLocaleString()}`;
    const pct = Math.min((currentUsed / limitVal) * 100, 100);
    document.getElementById('context-percent-text').innerText = `${pct.toFixed(1)}% used`;
    document.getElementById('context-bar').style.width = `${pct}%`;
}

// --- Init Charts ---
function createChart(ctxId, color) {
    const ctx = document.getElementById(ctxId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: color, borderWidth: 1.5, fill: true, backgroundColor: color.replace('1)', '0.1)'), pointRadius: 0, tension: 0.2 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { display: true, ticks: { color: '#6b7280', font: {size: 8} } } }, plugins: { legend: { display: false } } }
    });
}

function createDualAxisTpsChart(ctxId) {
    const ctx = document.getElementById(ctxId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Prefill',
                    data: [],
                    borderColor: 'rgba(96, 165, 250, 1)',
                    borderWidth: 2,
                    fill: false,
                    pointRadius: 3,
                    showLine: false,
                    yAxisID: 'yPrefill'
                },
                {
                    label: 'Generation',
                    data: [],
                    borderColor: 'rgba(74, 222, 128, 1)',
                    borderWidth: 1.5,
                    fill: true,
                    backgroundColor: 'rgba(74, 222, 128, 0.1)',
                    pointRadius: 0,
                    tension: 0.2,
                    yAxisID: 'yGen'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            scales: {
                x: { display: false },
                yPrefill: {
                    type: 'linear',
                    position: 'left',
                    ticks: { color: '#60a5fa', font: { size: 8 } },
                    grid: { color: 'rgba(96, 165, 250, 0.05)' }
                },
                yGen: {
                    type: 'linear',
                    position: 'right',
                    ticks: { color: '#4ade80', font: { size: 8 } },
                    grid: { drawOnChartArea: false }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function createDualLineChart(ctxId) {
    const ctx = document.getElementById(ctxId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Master', data: [], borderColor: 'rgba(250, 204, 21, 1)', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.2 },
                { label: 'Worker', data: [], borderColor: 'rgba(248, 113, 113, 1)', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.2 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { display: true, ticks: { color: '#6b7280', font: {size: 8} } } }, plugins: { legend: { display: false } } }
    });
}

tpsChart = createDualAxisTpsChart('tpsChart');
netChart = createChart('netChart', 'rgba(96, 165, 250, 1)');
let tempChart = createDualLineChart('tempChart');
let pwrChart = createDualLineChart('pwrChart');
let cpuChart = createDualLineChart('cpuChart');
let gpuUtilChart = createDualLineChart('gpuUtilChart');
let cpuTempChart = createDualLineChart('cpuTempChart');

let tempHistory = []; let pwrHistory = []; let cpuHistory = [];
let gpuUtilHistory = []; let cpuTempHistory = [];

// UI Listeners for Transport and Tensor Split
document.getElementById('transport-type').addEventListener('change', (e) => {
    const val = e.target.value;
    const sshInput = document.getElementById('worker-ssh');
    if (val === 'TB4') {
        sshInput.value = 'kyle4090@169.254.61.173';
    } else {
        sshInput.value = 'kyle4090@192.168.1.125';
    }
});

document.getElementById('server-tensor-split').addEventListener('input', (e) => {
    const masterPct = e.target.value;
    const workerPct = 100 - masterPct;
    document.getElementById('ts-val-display').innerText = `${masterPct}% / ${workerPct}%`;
});

// --- Advanced panel toggle ---
document.getElementById('btn-advanced-toggle').addEventListener('click', () => {
    const panel = document.getElementById('advanced-panel');
    const icon = document.getElementById('advanced-icon');
    const isHidden = panel.classList.toggle('hidden');
    icon.innerHTML = isHidden ? '&#9654;' : '&#9660;';
});
document.getElementById('mtp-toggle').addEventListener('change', (e) => {
    document.getElementById('mtp-draft-n-row').classList.toggle('hidden', !e.target.checked);
});

// --- Fetch Local Models ---
async function fetchModels() {
    try {
        const res = await fetch('/api/models');
        const models = await res.json();
        const select = document.getElementById('model-select');
        select.innerHTML = '';
        models.forEach(m => { 
            const opt = document.createElement('option'); 
            // IMPORTANT: value is the full host path (not just filename) so the
            // server can correctly resolve models that live outside the local
            // /models mount (e.g. the Hugging Face cache dir).
            opt.value = m.path; opt.textContent = `${m.name} (${m.size} GB)${m.source === 'huggingface' ? ' [HF cache]' : ''}`; 
            select.appendChild(opt); 
        });
    } catch (e) {}
}
fetchModels();

// --- Server SSE State ---
let eventSource = new EventSource('/api/status');
window.addEventListener('beforeunload', () => eventSource.close());

// --- GLOBAL TRACKERS (Must be outside the handler) ---
let currentLoadTime = "N/A";
let uiTimerInterval = null;

function setHardwareConfigLocked(locked) {
    const hwc = document.getElementById('hardware-config-section');
    hwc.querySelectorAll('select, input, button').forEach(el => el.disabled = locked);
    hwc.classList.toggle('opacity-50', locked);
    hwc.classList.toggle('pointer-events-none', locked);
}

// --- THE SSE HANDLER ---
eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const badge = document.getElementById('engine-status');
    const input = document.getElementById('user-prompt');
    const btn = document.getElementById('submit-btn');
    const timerDiv = document.getElementById('boot-timer');

    // 0. ERRORS & LOGS (run first; never throws, so state handling below always runs)
    if (data.error) {
        displayErrorInUI(data.error);
    } else if (data.log) {
        appendLogToUI(data.log);
        if (data.log.startsWith('PREFILL_PROGRESS:')) {
            // Format from server: PREFILL_PROGRESS:<progress 0-1>:<tps>:<nTokens>
            const parts = data.log.split(':');
            const progress = parseFloat(parts[1]);
            const tps = parseFloat(parts[2]);
            const nTokens = parseInt(parts[3]);
            handlePrefillProgress(progress, tps, nTokens);
        }
    }

    // 1. Handle live ticking timer + boot overlay animation
    const bootOverlay = document.getElementById('boot-overlay');
    const bootTimerDisplay = document.getElementById('boot-timer-display');
    const bootStatusText = document.getElementById('boot-status-text');
    const bootProgressFill = document.getElementById('boot-progress-fill');

    if (data.loadStartTime > 0 && !uiTimerInterval) {
        timerDiv.classList.remove('hidden');
        // Show boot overlay in chat area
        bootOverlay.classList.remove('hidden');
        bootOverlay.classList.add('flex');
        // Hide empty state while booting
        const emptyStateEl = document.getElementById('empty-state');
        if (emptyStateEl) emptyStateEl.classList.add('hidden');

        uiTimerInterval = setInterval(() => {
            const elapsed = ((Date.now() - data.loadStartTime) / 1000).toFixed(1);
            timerDiv.innerText = `Booting: ${elapsed}s...`;
            bootTimerDisplay.innerText = `${elapsed}s`;
            // Update progress bar with a pseudo-progress based on elapsed time
            // Models typically take 5-60s to load, animate the bar slowly
            const pseudoPct = Math.min((parseFloat(elapsed) / 60) * 100, 95);
            bootProgressFill.style.width = `${pseudoPct}%`;
        }, 100);
    }

    // 2. Handle State Changes
    if (data.state === 'stopped') {
        clearInterval(uiTimerInterval); uiTimerInterval = null;
        // Hide boot overlay when engine is stopped
        bootOverlay.classList.add('hidden');
        bootOverlay.classList.remove('flex');
        bootProgressFill.style.width = '0%';
        timerDiv.classList.add('hidden');
        // Restore empty state
        const emptyStateEl = document.getElementById('empty-state');
        if (emptyStateEl && document.getElementById('chat-container').querySelector('.msg-wrapper') === null) {
            emptyStateEl.classList.remove('hidden');
        }
        badge.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-xs font-semibold';
        badge.innerHTML = '<span class="h-2 w-2 rounded-full bg-red-500"></span> ENGINE STOPPED';
        document.getElementById('btn-start-server').classList.remove('hidden'); 
        document.getElementById('btn-stop-server').classList.add('hidden');
        input.disabled = true; btn.disabled = true; isModelLoaded = false; isColdStart = true;

        // Restore hardware config controls (previously these could get stuck
        // disabled forever because this reset lived in an unreachable
        // duplicate 'stopped' branch further down)
        setHardwareConfigLocked(false);

        if (data.error) {
            const chatBox = document.getElementById('chat-container');
            if (document.getElementById('empty-state')) document.getElementById('empty-state').classList.add('hidden');
            chatBox.innerHTML += `<div class="msg-wrapper p-4 rounded-xl border border-red-900/50 bg-red-900/10 max-w-4xl mx-auto shadow-sm w-full mb-4 text-red-400 text-sm font-semibold">${escapeHtml(data.error)}</div>`;
            chatBox.scrollTop = chatBox.scrollHeight;
        }
        
        // Reset Telemetry
        document.getElementById('metric-prefill').innerText = '0.0 t/s';
        document.getElementById('metric-prefill-tokens').innerText = '0 tokens';
        document.getElementById('metric-gen').innerText = '0.0 t/s';
        document.getElementById('metric-gen-tokens').innerText = '0 tokens';
        document.getElementById('current-tps').innerText = '0.0';
        document.getElementById('metric-gen-avg').innerText = '0.0 t/s';
        document.getElementById('status-indicator').innerText = 'Generating...';
    
    } else if (data.state === 'starting' || data.state === 'loading') {
        setHardwareConfigLocked(true);

        badge.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-900/20 border border-yellow-800 text-yellow-400 text-xs font-semibold';
        badge.innerHTML = `<span class="h-2 w-2 rounded-full bg-yellow-500 animate-pulse"></span> ${data.state === 'loading' ? 'LOADING MODEL' : 'BOOTING...'}`;
        document.getElementById('btn-start-server').classList.add('hidden'); 
        document.getElementById('btn-stop-server').classList.remove('hidden');
    } else if (!isModelLoaded) { 
        isModelLoaded = true; 
        setTimeout(() => { masterBaseVram = currentVramSnapshot; }, 2000); 

        // BUG FIX: Hide boot overlay when model is fully loaded
        if (uiTimerInterval) { clearInterval(uiTimerInterval); uiTimerInterval = null; }
        bootProgressFill.style.width = '100%';
        bootStatusText.innerText = 'Model Loaded!';
        setTimeout(() => {
            bootOverlay.classList.add('hidden');
            bootOverlay.classList.remove('flex');
            // Restore empty state if chat is empty
            const emptyStateEl = document.getElementById('empty-state');
            if (emptyStateEl) emptyStateEl.classList.remove('hidden');
        }, 600);
    }
};

document.getElementById('btn-start-server').addEventListener('click', () => {
    const mtpEnabled = document.getElementById('mtp-toggle').checked;
    const verbosityVal = parseInt(document.getElementById('server-verbosity').value);
    const config = {
        modelPath: document.getElementById('model-select').value, // full host path, not just filename
        ctx: parseInt(document.getElementById('server-ctx').value),
        ngl: parseInt(document.getElementById('server-ngl').value),
        rpcTarget: document.getElementById('rpc-toggle').checked ? document.getElementById('worker-ssh').value.trim() : null,
        fa: document.getElementById('server-fa').checked,
        cacheK: document.getElementById('server-cache-k').value,
        cacheV: document.getElementById('server-cache-v').value,
        tensorSplit: document.getElementById('rpc-toggle').checked ? parseInt(document.getElementById('server-tensor-split').value) : null,
        specType: mtpEnabled ? 'draft-mtp' : null,
        specDraftNMax: mtpEnabled ? parseInt(document.getElementById('mtp-draft-n').value || '2') : null,
        reasoningPreserve: document.getElementById('reasoning-preserve-toggle').checked,
        verbosity: Number.isFinite(verbosityVal) ? verbosityVal : null
    };
    fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
});
document.getElementById('btn-stop-server').addEventListener('click', () => fetch('/api/stop', { method: 'POST' }));

// --- HF Modal Logic ---
function openHFModal() { document.getElementById('hf-modal').classList.remove('hidden'); document.getElementById('hf-modal').classList.add('flex'); }
function closeHFModal() { document.getElementById('hf-modal').classList.add('hidden'); document.getElementById('hf-modal').classList.remove('flex'); }
async function searchHF() {
    const q = document.getElementById('hf-search-input').value.trim();
    if(!q) return;
    const resDiv = document.getElementById('hf-results'); resDiv.innerHTML = '<div class="text-sm text-gray-400">Searching...</div>';
    try {
        const res = await fetch(`https://huggingface.co/api/models?search=${q}&sort=downloads&direction=-1&limit=10`);
        const data = await res.json();
        resDiv.innerHTML = data.filter(m => m.id.toLowerCase().includes('gguf')).map(m => `
            <div class="bg-gray-800 p-3 rounded-lg border border-gray-700">
                <div class="font-bold text-sm text-indigo-400">${m.id}</div>
                <div class="text-[10px] text-gray-500 mt-1 mb-2">Downloads: ${m.downloads}</div>
                <div class="bg-gray-900 p-2 rounded border border-gray-700 flex justify-between items-center group">
                    <code class="text-[10px] text-gray-400 select-all font-mono">wget https://huggingface.co/${m.id}/resolve/main/model.gguf -P ./models/</code>
                </div>
            </div>
        `).join('') || '<div class="text-sm text-gray-500">No GGUF models found.</div>';
    } catch (e) { resDiv.innerHTML = '<div class="text-sm text-red-400">Search failed.</div>'; }
}

// --- Chat & Benchmarking Logic ---
function toggleRaw(btnEl, isMarkdown) {
    const contentDiv = btnEl.closest('.msg-wrapper').querySelector('.msg-content');
    const rawText = btnEl.dataset.raw;
    if (btnEl.dataset.mode === 'raw') {
        contentDiv.innerHTML = isMarkdown ? marked.parse(rawText) : escapeHtml(rawText);
        contentDiv.className = isMarkdown ? 'msg-content prose prose-invert max-w-none text-sm mt-2 overflow-x-auto break-words' : 'msg-content text-gray-100 text-sm mt-2 whitespace-pre-wrap overflow-x-auto break-words';
        btnEl.dataset.mode = 'rendered';
        btnEl.innerText = 'View Raw';
    } else {
        contentDiv.innerHTML = `<pre class="text-xs text-gray-300 overflow-x-auto p-3 bg-gray-950 rounded border border-gray-800">${escapeHtml(rawText)}</pre>`;
        contentDiv.className = 'msg-content mt-2 overflow-x-auto break-words';
        btnEl.dataset.mode = 'raw';
        btnEl.innerText = 'View Rendered';
    }
}

function toggleReasoning(headerEl) {
    const body = headerEl.nextElementSibling;
    const icon = headerEl.querySelector('.r-icon');
    if (body.style.maxHeight) {
        body.style.maxHeight = null;
        body.classList.remove('fade-bottom');
        icon.innerText = '▲';
    } else {
        body.style.maxHeight = '4.5rem';
        body.classList.add('fade-bottom');
        icon.innerText = '▼';
    }
}

let currentVramSnapshot = 0;
let chatContext = []; // Stores conversation history for the API
let isColdStart = true;

// --- Prefill sparkline (replaces the old flat prefill/think/answer bar) ---
// `points` is an array of {progress, tps} samples captured live from the
// server's PREFILL_PROGRESS broadcasts during the current generation.
let activePrefillSamples = [];
let activeTimelineEls = null; // { svg, prefillLine, thinkLine, answerLine } for the in-flight response bubble

function handlePrefillProgress(progress, tps, nTokens) {
    if (!isNaN(progress) && !isNaN(tps)) {
        activePrefillSamples.push({ progress, tps });
    }
    const elapsed = ((Date.now() - (window.__promptStartTime || Date.now())) / 1000).toFixed(1);
    const pct = isNaN(progress) ? 0 : (progress * 100).toFixed(1);
    document.getElementById('status-indicator').innerText = isNaN(tps)
        ? `Prefilling (${pct}%)... [${elapsed}s]`
        : `Prefilling (${pct}%, ${tps.toFixed(0)} t/s)... [${elapsed}s]`;

    // Live prefill speed in the sidebar card, updated as real samples arrive
    if (!isNaN(tps)) {
        document.getElementById('metric-prefill').innerText = `${tps.toFixed(1)} t/s`;
        if (!isNaN(nTokens)) document.getElementById('metric-prefill-tokens').innerText = `${nTokens} tokens`;
    }

    // Update the prefill loading bar inside the active response bubble
    const activeBubble = document.getElementById('active-ast');
    if (activeBubble) {
        const barContainer = activeBubble.querySelector('.prefill-loading-bar-container');
        if (barContainer) {
            barContainer.classList.remove('hidden');
            const fill = barContainer.querySelector('.prefill-bar-fill');
            const pctSpan = barContainer.querySelector('.prefill-bar-pct');
            const tokensSpan = barContainer.querySelector('.prefill-bar-tokens');
            const tpsSpan = barContainer.querySelector('.prefill-bar-tps');
            if (fill) fill.style.width = `${pct}%`;
            if (pctSpan) pctSpan.innerText = `${pct}%`;
            if (tokensSpan) tokensSpan.innerText = isNaN(nTokens) ? '0' : nTokens.toLocaleString();
            if (tpsSpan) tpsSpan.innerText = isNaN(tps) ? '0' : tps.toFixed(0);
        }
    }

    drawPrefillSparkline(activeTimelineEls, activePrefillSamples, 1, 0, 0, true);
}

// Hide the prefill loading bar when prefill phase is complete
function hidePrefillLoadingBar() {
    const activeBubble = document.getElementById('active-ast');
    if (activeBubble) {
        const barContainer = activeBubble.querySelector('.prefill-loading-bar-container');
        if (barContainer) barContainer.classList.add('hidden');
    }
}

// Builds/updates the SVG timeline. widthPct* are 0-100 proportions of the
// total elapsed time occupied by each phase; samples is the live/stored
// {progress, tps}[] array for the prefill phase (the only phase we have a
// real time series for).
function drawPrefillSparkline(els, samples, prefillWidthPct, thinkWidthPct, answerWidthPct, stillLoading) {
    if (!els) return;
    const VB_W = 1000, VB_H = 100, MID = 50;
    const totalPct = stillLoading ? 100 : (prefillWidthPct + thinkWidthPct + answerWidthPct) || 100;
    const pStart = 0;
    const pEnd = stillLoading ? VB_W : (prefillWidthPct / totalPct) * VB_W;
    const tEnd = stillLoading ? VB_W : pEnd + (thinkWidthPct / totalPct) * VB_W;
    const aEnd = stillLoading ? VB_W : tEnd + (answerWidthPct / totalPct) * VB_W;

    if (samples && samples.length > 0) {
        const tpsVals = samples.map(s => s.tps).filter(v => !isNaN(v));
        const maxTps = Math.max(...tpsVals, 1);
        const minTps = Math.min(...tpsVals, maxTps);
        const range = Math.max(maxTps - minTps, 1);
        const pts = samples.map(s => {
            const x = pStart + (isNaN(s.progress) ? 0 : s.progress) * (pEnd - pStart);
            const norm = isNaN(s.tps) ? 0.5 : (s.tps - minTps) / range;
            const y = VB_H - 10 - (norm * (VB_H - 20)); // higher tps -> higher on the graph
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        els.prefillLine.setAttribute('points', pts.join(' '));
    } else {
        // No samples yet (or none ever arrived) -- flat placeholder line so
        // the segment is still visible.
        els.prefillLine.setAttribute('points', `${pStart},${MID} ${pEnd},${MID}`);
    }

    if (!stillLoading) {
        els.thinkLine.setAttribute('points', thinkWidthPct > 0 ? `${pEnd},${MID} ${tEnd},${MID}` : '');
        els.answerLine.setAttribute('points', answerWidthPct > 0 ? `${tEnd},${MID} ${aEnd},${MID}` : '');
    }
}

// Active-response hardware chart state (set by submitPrompt, read by pollTelemetry)
let responseMetrics = [];
let hwChartInst = null;
let hwChartContainer = null;
let hwChartCanvas = null;

async function submitPrompt() {
    const inputEl = document.getElementById('user-prompt');
    const text = inputEl.value.trim();
    if (!text) return;

    const timestamp = new Date().toLocaleTimeString();
    chatContext.push({ role: 'user', content: text, timestamp });

    // Always pass full chat context so the server can reuse KV-cache
    const apiMessages = chatContext.map(m => ({role: m.role, content: m.content}));

    // Prepare UI & Reset session data
    inputEl.disabled = true; document.getElementById('submit-btn').disabled = true; document.getElementById('status-indicator').classList.remove('hidden'); document.getElementById('abort-btn').classList.remove('hidden');
    document.getElementById('status-indicator').innerText = 'Loading context...';

    // Build UI Bubbles
    const chatBox = document.getElementById('chat-container');
    chatBox.innerHTML += `
        <div class="msg-wrapper p-4 rounded-xl border border-gray-700 bg-gray-800 max-w-4xl mx-auto shadow-sm w-full mb-4">
            <div class="flex justify-between items-center mb-2">
                <div class="text-xs text-gray-300 uppercase">User</div>
                <div class="flex items-center gap-3">
                    <div class="text-[10px] text-gray-500">${timestamp}</div>
                    <button class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors" data-mode="rendered" data-raw="${escapeHtml(text)}" onclick="toggleRaw(this, false)">View Raw</button>
                </div>
            </div>
            <div class="msg-content text-sm text-gray-100 whitespace-pre-wrap overflow-x-auto break-words">${escapeHtml(text)}</div>
        </div>
        <div id="active-ast" class="msg-wrapper p-5 rounded-xl border border-indigo-900/30 bg-gray-900 max-w-4xl mx-auto shadow-sm w-full mb-4">
            <div class="flex justify-between items-center mb-2">
                <div class="text-xs text-indigo-400 uppercase tracking-wider">Assistant</div>
                <div class="flex items-center gap-3">
                    <div class="text-[10px] text-gray-500">${timestamp}</div>
                    <button class="raw-btn text-[10px] text-gray-500 hover:text-gray-300 transition-colors hidden" data-mode="rendered" onclick="toggleRaw(this, true)">View Raw</button>
                </div>
            </div>
            <div class="metrics-timeline-container w-full mb-3 mt-2">
                <div class="timeline-graph-wrap w-full h-6 rounded-md bg-gray-800 overflow-hidden mb-1">
                    <svg class="timeline-graph-svg w-full h-full" viewBox="0 0 1000 100" preserveAspectRatio="none">
                        <polyline class="timeline-prefill-line" points="" fill="none" stroke="#eab308" stroke-width="6" />
                        <polyline class="timeline-think-line" points="" fill="none" stroke="#3b82f6" stroke-width="6" />
                        <polyline class="timeline-answer-line" points="" fill="none" stroke="#22c55e" stroke-width="6" />
                    </svg>
                </div>
                <div class="flex text-[9px] text-gray-500 gap-4 px-1">
                    <div class="label-prefill text-yellow-500/80 font-mono">Loading Context...</div>
                    <div class="label-think text-blue-500/80 font-mono hidden">Think: <span class="val"></span></div>
                    <div class="label-answer text-green-500/80 font-mono hidden">Answer: <span class="val"></span></div>
                </div>
                <!-- Prefill Loading Bar -->
                <div class="prefill-loading-bar-container hidden mt-2 space-y-1">
                    <div class="flex justify-between text-[9px] font-mono">
                        <span class="prefill-bar-label text-yellow-400">Processing Prompt...</span>
                        <span class="prefill-bar-stats text-gray-400"><span class="prefill-bar-pct">0%</span> &mdash; <span class="prefill-bar-tokens">0</span> tokens @ <span class="prefill-bar-tps">0</span> t/s</span>
                    </div>
                    <div class="w-full bg-gray-950 rounded-full h-2 overflow-hidden border border-gray-800">
                        <div class="prefill-bar-fill bg-gradient-to-r from-yellow-600 to-yellow-400 h-full rounded-full transition-all duration-150 ease-out" style="width: 0%"></div>
                    </div>
                </div>
                <div class="hw-chart-container hidden mt-2 border border-gray-800/60 rounded-lg bg-gray-950/50 p-2" style="height:100px">
                    <canvas class="hw-chart-canvas"></canvas>
                </div>
            </div>
            <div class="reasoning-container hidden border border-gray-800 rounded-lg bg-gray-950/50 mb-3 mt-2">
                <div class="flex justify-between px-3 py-1.5 bg-gray-800/30 text-[10px] text-gray-400 border-b border-gray-800 cursor-pointer hover:bg-gray-800/50 transition-colors" onclick="toggleReasoning(this)">
                    <span>🧠 Reasoning Trace <span class="r-tokens text-gray-500 ml-1">(~0 tokens)</span></span>
                    <span class="r-icon">▼</span>
                </div>
                <div class="reasoning-body text-xs text-gray-500 font-mono p-3 overflow-x-auto overflow-y-hidden relative cursor-pointer fade-bottom" style="max-height: 4.5rem;" onclick="toggleReasoning(this.previousElementSibling)"></div>
            </div>
            <div class="msg-content prose prose-invert max-w-none text-sm overflow-x-auto break-words"></div>
        </div>
    `;
    chatBox.scrollTop = chatBox.scrollHeight;
    const astEl = document.getElementById('active-ast');
    const contentBody = astEl.querySelector('.msg-content');
    const reasoningBox = astEl.querySelector('.reasoning-container');
    const reasoningBody = astEl.querySelector('.reasoning-body');
    const reasoningTokens = astEl.querySelector('.r-tokens');
    const rawBtn = astEl.querySelector('.raw-btn');

    abortController = new AbortController();
    let tokenCount = 0; 
    let startTime = Date.now();
    window.__promptStartTime = startTime;
    let timeToFirstToken = 0;
    let timeToFirstContent = 0;
    let reasoningTokenCount = 0;
    let answerTokenCount = 0;
    let prefillMetrics = null;
    let thinkMetrics = null;
    let answerMetrics = null;
    // Reset module-level hw chart state for this new response
    responseMetrics = [];
    hwChartInst = null;
    hwChartContainer = astEl.querySelector('.hw-chart-container');
    hwChartCanvas = astEl.querySelector('.hw-chart-canvas');

    // Reset prefill sparkline state for this new response
    activePrefillSamples = [];
    activeTimelineEls = {
        svg: astEl.querySelector('.timeline-graph-svg'),
        prefillLine: astEl.querySelector('.timeline-prefill-line'),
        thinkLine: astEl.querySelector('.timeline-think-line'),
        answerLine: astEl.querySelector('.timeline-answer-line')
    };
    
    const timelineEls = {
        container: astEl.querySelector('.metrics-timeline-container'),
        pLbl: astEl.querySelector('.label-prefill'),
        tLbl: astEl.querySelector('.label-think'),
        aLbl: astEl.querySelector('.label-answer')
    };
    
    // Start CSV Data payload
    sessionData = {
        model: document.getElementById('model-select').value,
        ctx: document.getElementById('server-ctx').value,
        ngl: document.getElementById('server-ngl').value,
        rpc: document.getElementById('rpc-toggle').checked ? 'yes' : 'no',
        transport: document.getElementById('transport-type').value,
        gpuMem: currentVramSnapshot,
        wallTime: 0,
        loadTime: currentLoadTime 
    };

    // Reset charts
    tpsHistory = []; netHistory = [];
    window.chartEvents = [];
    window.chartEvents.push({ time: Date.now(), label: 'Prompt Start', color: '#60a5fa', offset: 0 });
    tpsChart.data.labels = [];
    tpsChart.data.datasets[0].data = []; // Prefill Speed
    tpsChart.data.datasets[1].data = []; // Gen Speed
    tpsChart.update('none');

    // Reset live numbers
    document.getElementById('metric-prefill').innerText = '0.0 t/s';
    document.getElementById('metric-prefill-tokens').innerText = '0 tokens';
    document.getElementById('metric-gen').innerText = '0.0 t/s';
    document.getElementById('metric-gen-tokens').innerText = '0 tokens';

    // Calculate context limit and estimate prompt tokens
    currentContextLimit = parseInt(document.getElementById('server-ctx').value) || 32768;
    const estimatedPromptTokens = Math.ceil((text.length + 100) / 4) + currentContextTokens;
    updateContextUI(estimatedPromptTokens, currentContextLimit);

    let totalTokensGenerated = 0;
    window.lastSlotProgress = '';

    let slotsLoop = setInterval(async () => {
        if (timeToFirstToken > 0) return clearInterval(slotsLoop);
        try {
            const res = await fetch('http://localhost:8080/slots');
            const slots = await res.json();
            if (slots && slots.length > 0) {
                const slot = slots.find(s => s.state === 1) || slots[0];
                if (slot.n_prompt_tokens > 0) {
                    const pct = Math.min((slot.n_decoded / slot.n_prompt_tokens) * 100, 100).toFixed(1);
                    window.lastSlotProgress = `${slot.n_decoded} / ${slot.n_prompt_tokens} (${pct}%)`;
                }
            }
        } catch (e) {}
    }, 250);

    let tpsLoop = setInterval(() => {
        const tps = tokenCount; tokenCount = 0; // Reset every sec for current TPS
        document.getElementById('current-tps').innerText = tps.toFixed(1);
        document.getElementById('metric-gen').innerText = `${tps.toFixed(1)} t/s`;
        
        tpsHistory.push({ time: Math.floor((Date.now()-startTime)/1000), tps });
        if(tpsHistory.length > 30) tpsHistory.shift();
        
        tpsChart.data.labels = tpsHistory.map(h => h.time); 
        tpsChart.data.datasets[0].data = tpsHistory.map(h => null);
        tpsChart.data.datasets[1].data = tpsHistory.map(h => h.tps);
        tpsChart.update('none');

        if (timeToFirstToken === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            if (window.lastSlotProgress) {
                document.getElementById('status-indicator').innerText = `Loading context... ${window.lastSlotProgress} [${elapsed}s]`;
            } else {
                document.getElementById('status-indicator').innerText = `Loading context... [${elapsed}s]`;
            }
        } else {
            document.getElementById('status-indicator').innerText = 'Generating...';
        }

        // Dynamic Context growth during streaming
        const liveContext = estimatedPromptTokens + totalTokensGenerated;
        updateContextUI(liveContext, currentContextLimit);
        document.getElementById('metric-gen-tokens').innerText = `${totalTokensGenerated} tokens`;
        
        // Live Generation Average calculation
        if (timeToFirstToken > 0) {
            const genTime = ((Date.now() - startTime) / 1000) - timeToFirstToken;
            if (genTime > 0.1) {
                const liveAvg = (totalTokensGenerated / genTime).toFixed(1);
                document.getElementById('metric-gen-avg').innerText = `${liveAvg} t/s`;
            }
        }
    }, 1000);

    try {
        const response = await fetch('http://localhost:8080/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: sessionData.model, messages: apiMessages, stream: true, stream_options: { include_usage: true } }),
            signal: abortController.signal
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullContent = ""; let fullReasoning = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            
            if (timeToFirstToken === 0) {
                window.chartEvents.push({ time: Date.now(), label: 'Prefill Done', color: '#facc15', offset: 20 });
                timeToFirstToken = (Date.now() - startTime) / 1000; // in seconds
                sessionData.promptLatency = timeToFirstToken.toFixed(2);
                
                // Hide the prefill loading bar now that prompt processing is done
                hidePrefillLoadingBar();
                
                const promptTokensEst = estimatedPromptTokens - currentContextTokens;
                const livePrefillAvg = (promptTokensEst / timeToFirstToken).toFixed(1);
                prefillMetrics = { time: timeToFirstToken.toFixed(1), tokens: promptTokensEst, tps: livePrefillAvg };
                
                timelineEls.pLbl.innerHTML = `Prefill: <span class="val text-gray-200">${prefillMetrics.time}s | ${prefillMetrics.tokens}t | ${prefillMetrics.tps} t/s</span>`;
                timelineEls.container.classList.remove('hidden');

                // Live update prefill sidebar metrics
                document.getElementById('metric-prefill-avg').innerText = `${livePrefillAvg} t/s`;
                document.getElementById('metric-prefill').innerText = `${livePrefillAvg} t/s`;
                document.getElementById('metric-prefill-tokens').innerText = `${promptTokensEst} tokens`;
            }

            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        
                        // End of stream Usage metrics
                        if (data.usage) {
                            sessionData.genTokens = data.usage.completion_tokens;
                            sessionData.reasonTokens = reasoningTokenCount; 
                            sessionData.promptTps = prefillMetrics.tps;
                            
                            const finalAnsTime = ((Date.now() - startTime) / 1000) - timeToFirstToken - timeToFirstContent;
                            answerMetrics = { time: finalAnsTime.toFixed(1), tokens: answerTokenCount, tps: (answerTokenCount/finalAnsTime).toFixed(1) };
                            timelineEls.aLbl.innerHTML = `Answer: <span class="val text-gray-200">${answerMetrics.time}s | ${answerMetrics.tokens}t | ${answerMetrics.tps} t/s</span>`;
                            
                            // Final static render of the sparkline: proportional widths by time, real tps curve for prefill
                            const totalTime = timeToFirstToken + timeToFirstContent + finalAnsTime;
                            const pPct = totalTime > 0 ? (timeToFirstToken / totalTime) * 100 : 100;
                            const tPct = totalTime > 0 ? (timeToFirstContent / totalTime) * 100 : 0;
                            const aPct = totalTime > 0 ? (finalAnsTime / totalTime) * 100 : 0;
                            drawPrefillSparkline(activeTimelineEls, activePrefillSamples, pPct, tPct, aPct, false);
                            
                            sessionData.genTps = answerMetrics.tps;
                            sessionData.wallTime = (Date.now() - startTime) / 1000;

                            // Lock in exact numbers
                            document.getElementById('metric-prefill').innerText = `${sessionData.promptTps} t/s`;
                            document.getElementById('metric-prefill-tokens').innerText = `${data.usage.prompt_tokens} tokens`;
                            document.getElementById('metric-gen').innerText = `${sessionData.genTps} t/s`;
                            document.getElementById('metric-gen-tokens').innerText = `${data.usage.completion_tokens} tokens`;

                            // Save to running averages
                            saveMetricsToAverages(sessionData.promptTps, sessionData.genTps);

                            // Lock in exact context tokens
                            currentContextTokens = data.usage.prompt_tokens + data.usage.completion_tokens;
                            updateContextUI(currentContextTokens, currentContextLimit);

                            // Plot the Prefill speed spike at the start of the chart
                            if (tpsChart.data.datasets[0].data.length > 0) {
                                tpsChart.data.datasets[0].data[0] = parseFloat(sessionData.promptTps);
                                tpsChart.update('none');
                            }
                        }

                        if (data.choices && data.choices.length > 0) {
                            tokenCount++; totalTokensGenerated++;
                            const delta = data.choices[0].delta;
                            
                            if (delta.reasoning_content) {
                                if (reasoningTokenCount === 0) {
                                    timelineEls.tLbl.classList.remove('hidden');
                                }
                                reasoningTokenCount++;
                                
                                const currThinkTime = ((Date.now() - startTime) / 1000) - timeToFirstToken;
                                if (currThinkTime > 0.1) {
                                    timelineEls.tLbl.innerHTML = `Think: <span class="val text-gray-200">${currThinkTime.toFixed(1)}s | ${reasoningTokenCount}t | ${(reasoningTokenCount/currThinkTime).toFixed(1)} t/s</span>`;
                                }
                                
                                fullReasoning += delta.reasoning_content;
                                reasoningBox.classList.remove('hidden');
                                reasoningBody.innerText = fullReasoning;
                                reasoningTokens.innerText = `(~${Math.ceil(fullReasoning.length/4)} tokens)`;
                                reasoningBody.scrollTop = reasoningBody.scrollHeight;
                            }
                            if (delta.content) {
                                if (timeToFirstContent === 0) {
                                    timeToFirstContent = ((Date.now() - startTime) / 1000) - timeToFirstToken;
                                    timelineEls.aLbl.classList.remove('hidden');
                                    
                                    if (reasoningTokenCount > 0) {
                                        thinkMetrics = { time: timeToFirstContent.toFixed(1), tokens: reasoningTokenCount, tps: (reasoningTokenCount/timeToFirstContent).toFixed(1) };
                                        timelineEls.tLbl.innerHTML = `Think: <span class="val text-gray-200">${thinkMetrics.time}s | ${thinkMetrics.tokens}t | ${thinkMetrics.tps} t/s</span>`;
                                    }
                                }
                                answerTokenCount++;
                                
                                const currAnsTime = ((Date.now() - startTime) / 1000) - timeToFirstToken - timeToFirstContent;
                                if (currAnsTime > 0.1) {
                                    timelineEls.aLbl.innerHTML = `Answer: <span class="val text-gray-200">${currAnsTime.toFixed(1)}s | ${answerTokenCount}t | ${(answerTokenCount/currAnsTime).toFixed(1)} t/s</span>`;
                                }
                                
                                fullContent += delta.content;
                                
                                if (rawBtn.dataset.mode === 'rendered') {
                                    contentBody.innerHTML = marked.parse(fullContent);
                                } else {
                                    contentBody.innerHTML = `<pre class="text-xs text-gray-300 overflow-x-auto p-3 bg-gray-950 rounded border border-gray-800">${escapeHtml(fullContent)}</pre>`;
                                }
                                rawBtn.dataset.raw = fullContent;
                                rawBtn.classList.remove('hidden');
                            }
                            
                            // Auto scroll only if close to bottom
                            if(chatBox.scrollHeight - chatBox.scrollTop < chatBox.clientHeight + 100) {
                                chatBox.scrollTop = chatBox.scrollHeight;
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        chatContext.push({ role: 'assistant', content: fullContent, reasoning: fullReasoning, timestamp: new Date().toLocaleTimeString(), prefillMetrics, thinkMetrics, answerMetrics, responseMetrics, prefillSamples: activePrefillSamples });
        currentContextTokens = estimatedPromptTokens + totalTokensGenerated;
        // Reset active chart references so pollTelemetry stops feeding them
        responseMetrics = [];
        hwChartInst = null;
        activeTimelineEls = null;
        activePrefillSamples = [];
        saveChatSession(); // Save updated session history

        window.chartEvents.push({ time: Date.now(), label: 'Resp Done', color: '#4ade80', offset: 40 });

        // Stop UI state
        clearInterval(tpsLoop);
        clearInterval(slotsLoop);
        document.getElementById('submit-btn').disabled = false; document.getElementById('abort-btn').classList.add('hidden'); document.getElementById('status-indicator').classList.add('hidden'); inputEl.disabled = false; inputEl.value = ''; inputEl.focus();
        
        // Save averages to local storage at the end
        saveMetricsToAverages(sessionData.promptTps, sessionData.genTps);

        // Write to CSV
        try {
            if (isColdStart) {
                isColdStart = false; // Mark cold start as consumed
            } else {
                await fetch('/api/log', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(sessionData) });
            }
        } catch(e) {}
        
    } catch (err) { if(err.name!=='AbortError') contentBody.innerHTML += `<br>Error: ${escapeHtml(err.message)}`; }
    finally {
        clearInterval(tpsLoop); clearInterval(slotsLoop); abortController = null;
        inputEl.disabled = false; inputEl.focus(); document.getElementById('submit-btn').disabled = false;
        document.getElementById('status-indicator').classList.add('hidden'); document.getElementById('abort-btn').classList.add('hidden');
        document.getElementById('active-ast').removeAttribute('id');
        // Stop pollTelemetry from feeding the completed bubble's chart
        hwChartContainer = null; hwChartCanvas = null; hwChartInst = null;
        activeTimelineEls = null; activePrefillSamples = [];
        // Reset prompt token counter
        document.getElementById('input-token-count').innerText = '~0 tokens';
    }
}

document.getElementById('submit-btn').addEventListener('click', submitPrompt);

// --- Live token counter on prompt textarea ---
document.getElementById('user-prompt').addEventListener('input', (e) => {
    const est = Math.ceil(e.target.value.length / 4);
    document.getElementById('input-token-count').innerText = `~${est} tokens`;
});

// --- Initialize Context UI ---
updateContextUI(0, document.getElementById('server-ctx').value);
document.getElementById('server-ctx').addEventListener('input', (e) => {
    currentContextLimit = parseInt(e.target.value) || 32768;
    updateContextUI(currentContextTokens, currentContextLimit);
});

// --- Worker Docker Control & Polling Logic ---
let showWorkerLogs = false;
let workerStatusInterval = null;
let workerLogsInterval = null;

async function updateWorkerStatus() {
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    const rpcEnabled = document.getElementById('rpc-toggle').checked;
    const badge = document.getElementById('worker-status-badge');
    
    if (!workerSsh || !rpcEnabled) {
        badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-gray-850 text-gray-500';
        badge.innerText = 'DISABLED';
        return;
    }
    
    try {
        const res = await fetch('/api/worker/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        
        // Only update if not currently transitioning (animating pulse)
        if (!badge.classList.contains('animate-pulse')) {
            const startBtn = document.getElementById('btn-worker-start');
            const tsContainer = document.getElementById('tensor-split-container');
            if (data.status === 'running') {
                badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-green-900/20 border border-green-800 text-green-400';
                badge.innerText = 'RUNNING';
                tsContainer.classList.remove('hidden');
                startBtn.disabled = true;
                startBtn.classList.add('opacity-50', 'cursor-not-allowed');
            } else if (data.status === 'stopped') {
                badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-yellow-900/20 border border-yellow-800 text-yellow-400';
                badge.innerText = 'STOPPED';
                tsContainer.classList.add('hidden');
                startBtn.disabled = false;
                startBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            } else if (data.status === 'offline') {
                badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
                badge.innerText = 'OFFLINE';
                tsContainer.classList.add('hidden');
                startBtn.disabled = false;
                startBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    } catch (e) {
        if (!badge.classList.contains('animate-pulse')) {
            badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
            badge.innerText = 'ERROR';
        }
    }
}

async function fetchWorkerLogs() {
    if (!showWorkerLogs) return;
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    const rpcEnabled = document.getElementById('rpc-toggle').checked;
    if (!workerSsh || !rpcEnabled) return;
    try {
        const res = await fetch('/api/worker/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        document.getElementById('worker-logs-pre').innerText = data.logs || 'No logs returned.';
    } catch (e) {
        document.getElementById('worker-logs-pre').innerText = `Failed to fetch logs: ${e.message}`;
    }
}

document.getElementById('btn-worker-start').addEventListener('click', async () => {
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    if (!workerSsh) return;
    const badge = document.getElementById('worker-status-badge');
    badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-yellow-900/20 border border-yellow-800 text-yellow-400 animate-pulse';
    badge.innerText = 'STARTING...';
    try {
        const res = await fetch('/api/worker/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        badge.classList.remove('animate-pulse');
        if (data.success) {
            await updateWorkerStatus();
            if (showWorkerLogs) fetchWorkerLogs();
        } else {
            badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
            badge.innerText = 'START FAILED';
            document.getElementById('worker-logs-pre').innerText = `Start failed:\n${data.error}\n${data.stderr}`;
        }
    } catch (e) {
        badge.classList.remove('animate-pulse');
        badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
        badge.innerText = 'START FAILED';
        document.getElementById('worker-logs-pre').innerText = `Start failed: ${e.message}`;
    }
});

document.getElementById('btn-worker-stop').addEventListener('click', async () => {
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    if (!workerSsh) return;
    const badge = document.getElementById('worker-status-badge');
    badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-yellow-900/20 border border-yellow-800 text-yellow-400 animate-pulse';
    badge.innerText = 'STOPPING...';
    try {
        const res = await fetch('/api/worker/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        badge.classList.remove('animate-pulse');
        if (data.success) {
            await updateWorkerStatus();
        } else {
            badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
            badge.innerText = 'STOP FAILED';
        }
    } catch (e) {
        badge.classList.remove('animate-pulse');
        badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
        badge.innerText = 'STOP FAILED';
    }
});

document.getElementById('btn-worker-logs-toggle').addEventListener('click', () => {
    showWorkerLogs = !showWorkerLogs;
    const container = document.getElementById('worker-logs-pre');
    const icon = document.getElementById('worker-logs-icon');
    if (showWorkerLogs) {
        container.classList.remove('hidden');
        icon.innerText = '▼';
        fetchWorkerLogs();
        workerLogsInterval = setInterval(fetchWorkerLogs, 3000);
    } else {
        container.classList.add('hidden');
        icon.innerText = '▶';
        clearInterval(workerLogsInterval);
    }
});

// --- Master Logs Logic ---
let showMasterLogs = false;
let masterLogsInterval = null;

async function fetchMasterLogs() {
    if (!showMasterLogs) return;
    try {
        const res = await fetch('/api/master/logs');
        const data = await res.json();
        document.getElementById('master-logs-pre').innerText = data.logs || 'No logs returned.';
    } catch (e) {
        document.getElementById('master-logs-pre').innerText = `Failed to fetch logs: ${e.message}`;
    }
}

document.getElementById('btn-master-logs-toggle').addEventListener('click', () => {
    showMasterLogs = !showMasterLogs;
    const container = document.getElementById('master-logs-pre');
    const icon = document.getElementById('master-logs-icon');
    if (showMasterLogs) {
        container.classList.remove('hidden');
        icon.innerText = '▼';
        fetchMasterLogs();
        masterLogsInterval = setInterval(fetchMasterLogs, 3000);
    } else {
        container.classList.add('hidden');
        icon.innerText = '▶';
        clearInterval(masterLogsInterval);
    }
});

document.getElementById('rpc-toggle').addEventListener('change', () => {
    const controls = document.getElementById('worker-ssh-controls');
    if (document.getElementById('rpc-toggle').checked) {
        controls.classList.remove('opacity-50');
        controls.querySelectorAll('button, input').forEach(el => el.removeAttribute('disabled'));
        updateWorkerStatus();
    } else {
        controls.classList.add('opacity-50');
        controls.querySelectorAll('button, input').forEach(el => el.setAttribute('disabled', 'true'));
        document.getElementById('worker-status-badge').className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-gray-850 text-gray-500';
        document.getElementById('worker-status-badge').innerText = 'DISABLED';
    }
});

// Initialize polling intervals
workerStatusInterval = setInterval(updateWorkerStatus, 5000);
updateWorkerStatus();

// --- Hardware Polling ---
let workerBaseVram = 0;
let telemetryInterval = null;
let workerStatsMissingSince = null;

async function pollTelemetry() {
    try {
        const rpcEnabled = document.getElementById('rpc-toggle').checked;
        const workerSsh = rpcEnabled ? document.getElementById('worker-ssh').value : '';
        const res = await fetch('http://localhost:8081/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const stats = await res.json();

        // Guard: if the monitor didn't return master data at all, bail out
        // cleanly instead of throwing partway through a bunch of DOM writes.
        if (!stats || !stats.master) {
            document.getElementById('worker-status-badge').innerText = 'NO DATA';
            return;
        }
        
        let masterPwr = 0, masterTemp = 0, workerPwr = 0, workerTemp = 0;

        {
            currentVramSnapshot = stats.master.vram_used;
            sessionData.gpuUtil = stats.master.gpu_util; sessionData.gpuPwr = stats.master.gpu_pwr;
            sessionData.cpuUtil = stats.master.cpu_util; sessionData.ramUsage = stats.master.process_ram ?? stats.master.ram_used;
            sessionData.masterGpuTemp = stats.master.gpu_temp ?? 0;
            sessionData.masterCpuTemp = stats.master.cpu_temp ?? 0;
            masterPwr = stats.master.gpu_pwr;
            masterTemp = stats.master.gpu_temp;

            // Split VRAM Bar Master -- guarded against missing/zero vram_total
            // (this is what was previously showing a "full" bar next to "0 MB":
            // dividing by an undefined/0 total produced NaN/Infinity widths)
            const processVram = stats.master.process_vram ?? stats.master.vram_used;
            const vramTotal = stats.master.vram_total;
            const hasVramTotal = isNum(vramTotal) && vramTotal > 0;
            const wPct = hasVramTotal && masterBaseVram > 0 ? safeRatioPct(masterBaseVram, vramTotal) : 0;
            const cPct = hasVramTotal
                ? (masterBaseVram > 0 ? safeRatioPct(Math.max(processVram - masterBaseVram, 0), vramTotal) : safeRatioPct(processVram, vramTotal))
                : 0;
            const bgVram = Math.max((stats.master.vram_used ?? 0) - (processVram ?? 0), 0);
            const bgVramPct = hasVramTotal ? safeRatioPct(bgVram, vramTotal) : 0;
            
            document.getElementById('master-vram-text').innerText = hasVramTotal
                ? `${fmtUnit(stats.master.vram_used, ' MB')} (Llama: ${fmtUnit(processVram, ' MB')}, Sys: ${fmtUnit(bgVram, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(processVram, ' MB')}, Sys: --)`;
            document.getElementById('master-vram-weights').style.width = `${wPct}%`;
            document.getElementById('master-vram-ctx').style.width = `${cPct}%`;
            document.getElementById('master-vram-bg').style.width = `${bgVramPct}%`;

            // RAM Bar Master (Process vs Background) -- same guard pattern
            const processRam = sessionData.ramUsage;
            const totalRamUsed = stats.master.ram_used;
            const ramTotal = stats.master.ram_total;
            const hasRamTotal = isNum(ramTotal) && ramTotal > 0;
            const bgRam = Math.max((totalRamUsed ?? 0) - (processRam ?? 0), 0);
            const processRamPct = hasRamTotal ? safeRatioPct(processRam, ramTotal) : 0;
            const bgRamPct = hasRamTotal ? safeRatioPct(bgRam, ramTotal) : 0;
            
            document.getElementById('master-ram-text').innerText = hasRamTotal
                ? `${fmtUnit(totalRamUsed, ' MB')} (Llama: ${fmtUnit(processRam, ' MB')}, Sys: ${fmtUnit(bgRam, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(processRam, ' MB')}, Sys: --)`;
            document.getElementById('master-ram-bar').style.width = `${processRamPct}%`;
            document.getElementById('master-ram-bg').style.width = `${bgRamPct}%`;

            // Net Throughput Math
            const currentBytes = stats.master.net_bytes;
            if (isNum(currentBytes) && lastNetBytes > 0) {
                const mbs = (currentBytes - lastNetBytes) / 1_048_576; // True MB/s
                document.getElementById('current-net').innerHTML = `${mbs.toFixed(1)}<span class="text-[10px] text-gray-500 ml-1">MB/s</span>`;
                sessionData.netThroughput = mbs.toFixed(1); // logs peak or last
                netHistory.push({ time: Date.now(), mbps: mbs }); if(netHistory.length > 30) netHistory.shift();
                netChart.data.labels = netHistory.map(h => h.time); netChart.data.datasets[0].data = netHistory.map(h => h.mbps); netChart.update('none');
            }
            if (isNum(currentBytes)) lastNetBytes = currentBytes;
        }
        
        const workerReporting = !!(stats.worker && stats.worker.gpu_util !== undefined) && rpcEnabled;
        if (workerReporting) {
            workerStatsMissingSince = null;
            workerPwr = stats.worker.gpu_pwr;
            workerTemp = stats.worker.gpu_temp;
            
            document.getElementById('worker-vram-container').classList.remove('hidden');
            document.getElementById('worker-ram-container').classList.remove('hidden');
            
            if (!workerBaseVram && stats.worker.vram_used > 500 && isModelLoaded) workerBaseVram = stats.worker.process_vram ?? stats.worker.vram_used; // capture base after load

            const workerProcessVram = stats.worker.process_vram ?? stats.worker.vram_used;
            const workerVramTotal = stats.worker.vram_total;
            const hasWorkerVramTotal = isNum(workerVramTotal) && workerVramTotal > 0;
            const wPct = hasWorkerVramTotal && workerBaseVram > 0 ? safeRatioPct(workerBaseVram, workerVramTotal) : 0;
            const cPct = hasWorkerVramTotal
                ? (workerBaseVram > 0 ? safeRatioPct(Math.max(workerProcessVram - workerBaseVram, 0), workerVramTotal) : safeRatioPct(workerProcessVram, workerVramTotal))
                : 0;
            const workerBgVram = Math.max((stats.worker.vram_used ?? 0) - (workerProcessVram ?? 0), 0);
            const workerBgVramPct = hasWorkerVramTotal ? safeRatioPct(workerBgVram, workerVramTotal) : 0;

            document.getElementById('worker-vram-text').innerText = hasWorkerVramTotal
                ? `${fmtUnit(stats.worker.vram_used, ' MB')} (Llama: ${fmtUnit(workerProcessVram, ' MB')}, Sys: ${fmtUnit(workerBgVram, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(workerProcessVram, ' MB')}, Sys: --)`;
            document.getElementById('worker-vram-weights').style.width = `${wPct}%`;
            document.getElementById('worker-vram-ctx').style.width = `${cPct}%`;
            document.getElementById('worker-vram-bg').style.width = `${workerBgVramPct}%`;

            const workerRamUsed = stats.worker.process_ram ?? stats.worker.ram_used;
            const workerRamTotal = stats.worker.ram_total;
            const hasWorkerRamTotal = isNum(workerRamTotal) && workerRamTotal > 0;
            const ramPct = hasWorkerRamTotal ? safeRatioPct(workerRamUsed, workerRamTotal) : 0;
            const workerBgRam = Math.max((stats.worker.ram_used ?? 0) - (workerRamUsed ?? 0), 0);
            document.getElementById('worker-ram-text').innerText = hasWorkerRamTotal
                ? `${fmtUnit(stats.worker.ram_used, ' MB')} (Llama: ${fmtUnit(workerRamUsed, ' MB')}, Sys: ${fmtUnit(workerBgRam, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(workerRamUsed, ' MB')}, Sys: --)`;
            document.getElementById('worker-ram-bar').style.width = `${ramPct}%`;
            document.getElementById('worker-ram-bg').style.width = `${hasWorkerRamTotal ? safeRatioPct(workerBgRam, workerRamTotal) : 0}%`;

            sessionData.workerGpuUtil = stats.worker.gpu_util;
            sessionData.workerGpuPwr = workerPwr;
            sessionData.workerVram = stats.worker.vram_used;
            sessionData.workerRam = workerRamUsed;
            sessionData.workerGpuTemp = stats.worker.gpu_temp ?? 0;
            sessionData.workerCpuTemp = stats.worker.cpu_temp ?? 0;
        } else {
            document.getElementById('worker-vram-container').classList.add('hidden');
            document.getElementById('worker-ram-container').classList.add('hidden');
            if (rpcEnabled && !workerStatsMissingSince) workerStatsMissingSince = Date.now();
        }

        // If RPC is enabled and the worker docker container is reported
        // "RUNNING" but stats have been missing for a while, surface that
        // distinctly instead of silently showing blank cards -- this is
        // the monitor.py <-> worker-node stats path, separate from the
        // docker start/stop path, and the two can disagree.
        const wBadge = document.getElementById('worker-status-badge');
        if (rpcEnabled && !workerReporting && workerStatsMissingSince && (Date.now() - workerStatsMissingSince > 8000) && wBadge.innerText === 'RUNNING') {
            wBadge.title = 'Worker container is up but monitor.py is not receiving GPU stats from it.';
        }

        // Update Temp, Power, CPU Charts and Labels
        const mGpu = stats.master.gpu_name || 'GPU';
        const wGpu = (stats.worker && stats.worker.gpu_name) ? stats.worker.gpu_name : 'GPU';
        
        document.querySelectorAll('.master-gpu-model').forEach(el => el.innerText = `(${mGpu})`);
        document.querySelectorAll('.worker-gpu-model').forEach(el => el.innerText = `(${wGpu})`);
        
        const mCpu = stats.master.cpu_name || 'CPU';
        const wCpu = (stats.worker && stats.worker.cpu_name) ? stats.worker.cpu_name : 'CPU';
        document.querySelectorAll('.master-cpu-model').forEach(el => el.innerText = `(${mCpu})`);
        document.querySelectorAll('.worker-cpu-model').forEach(el => el.innerText = `(${wCpu})`);
        
        // GPU Throttling UI Indicator
        if (stats.master.gpu_throttle) {
            document.getElementById('card-gpu-temp').classList.add('bg-red-900/30', 'border-red-500/50', 'animate-pulse');
            document.getElementById('card-gpu-temp').classList.remove('bg-gray-800/50', 'border-gray-700/50');
        } else {
            document.getElementById('card-gpu-temp').classList.remove('bg-red-900/30', 'border-red-500/50', 'animate-pulse');
            document.getElementById('card-gpu-temp').classList.add('bg-gray-800/50', 'border-gray-700/50');
        }
        
        if (stats.worker && stats.worker.gpu_throttle) {
            document.getElementById('card-gpu-temp').classList.add('bg-red-900/30', 'border-red-500/50', 'animate-pulse');
            document.getElementById('card-gpu-temp').classList.remove('bg-gray-800/50', 'border-gray-700/50');
        }
        
        if (workerReporting) {
            document.getElementById('current-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterTemp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtUnit(workerTemp, '°C')}</span>`;
            document.getElementById('current-pwr').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterPwr, 'W')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtUnit(workerPwr, 'W')}</span>`;
            document.getElementById('current-cpu').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.cpu_util)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtPct(stats.worker.cpu_util)}</span>`;
            document.getElementById('current-gpu-util').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.gpu_util, 0)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtPct(stats.worker.gpu_util, 0)}</span>`;
            document.getElementById('current-cpu-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(stats.master.cpu_temp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtUnit(stats.worker.cpu_temp, '°C')}</span>`;
            const now = Date.now();
            tempHistory.push({ time: now, master: masterTemp, worker: workerTemp }); 
            pwrHistory.push({ time: now, master: masterPwr, worker: workerPwr }); 
            cpuHistory.push({ time: now, master: stats.master.cpu_util, worker: stats.worker.cpu_util }); 
            gpuUtilHistory.push({ time: now, master: stats.master.gpu_util, worker: stats.worker.gpu_util }); 
            cpuTempHistory.push({ time: now, master: stats.master.cpu_temp ?? 0, worker: stats.worker.cpu_temp ?? 0 }); 
            
            const tSlice = tempHistory.slice(-30);
            tempChart.data.labels = tSlice.map(h => h.time); tempChart.data.datasets[0].data = tSlice.map(h => h.master); tempChart.data.datasets[1].data = tSlice.map(h => h.worker); tempChart.update('none');
            const pSlice = pwrHistory.slice(-30);
            pwrChart.data.labels = pSlice.map(h => h.time); pwrChart.data.datasets[0].data = pSlice.map(h => h.master); pwrChart.data.datasets[1].data = pSlice.map(h => h.worker); pwrChart.update('none');
            const cSlice = cpuHistory.slice(-30);
            cpuChart.data.labels = cSlice.map(h => h.time); cpuChart.data.datasets[0].data = cSlice.map(h => h.master); cpuChart.data.datasets[1].data = cSlice.map(h => h.worker); cpuChart.update('none');
            const guSlice = gpuUtilHistory.slice(-30);
            gpuUtilChart.data.labels = guSlice.map(h => h.time); gpuUtilChart.data.datasets[0].data = guSlice.map(h => h.master); gpuUtilChart.data.datasets[1].data = guSlice.map(h => h.worker); gpuUtilChart.update('none');
            const ctSlice = cpuTempHistory.slice(-30);
            cpuTempChart.data.labels = ctSlice.map(h => h.time); cpuTempChart.data.datasets[0].data = ctSlice.map(h => h.master); cpuTempChart.data.datasets[1].data = ctSlice.map(h => h.worker); cpuTempChart.update('none');
        } else {
            document.getElementById('current-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterTemp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--°C</span>`;
            document.getElementById('current-pwr').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterPwr, 'W')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--W</span>`;
            document.getElementById('current-cpu').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.cpu_util)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--%</span>`;
            document.getElementById('current-gpu-util').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.gpu_util, 0)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--%</span>`;
            document.getElementById('current-cpu-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(stats.master.cpu_temp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--°C</span>`;
            
            const now = Date.now();
            tempHistory.push({ time: now, master: masterTemp, worker: null });
            pwrHistory.push({ time: now, master: masterPwr, worker: null });
            cpuHistory.push({ time: now, master: stats.master.cpu_util, worker: null });
            gpuUtilHistory.push({ time: now, master: stats.master.gpu_util, worker: null });
            cpuTempHistory.push({ time: now, master: stats.master.cpu_temp ?? 0, worker: null });

            const tSlice = tempHistory.slice(-30);
            tempChart.data.labels = tSlice.map(h => h.time); tempChart.data.datasets[0].data = tSlice.map(h => h.master); tempChart.update('none');
            const pSlice = pwrHistory.slice(-30);
            pwrChart.data.labels = pSlice.map(h => h.time); pwrChart.data.datasets[0].data = pSlice.map(h => h.master); pwrChart.update('none');
            const cSlice = cpuHistory.slice(-30);
            cpuChart.data.labels = cSlice.map(h => h.time); cpuChart.data.datasets[0].data = cSlice.map(h => h.master); cpuChart.update('none');
            const guSlice = gpuUtilHistory.slice(-30);
            gpuUtilChart.data.labels = guSlice.map(h => h.time); gpuUtilChart.data.datasets[0].data = guSlice.map(h => h.master); gpuUtilChart.update('none');
            const ctSlice = cpuTempHistory.slice(-30);
            cpuTempChart.data.labels = ctSlice.map(h => h.time); cpuTempChart.data.datasets[0].data = ctSlice.map(h => h.master); cpuTempChart.update('none');
        }
        // --- Feed active response hw chart ---
        if (typeof responseMetrics !== 'undefined' && hwChartCanvas) {
            const snap = {
                t: Date.now(),
                masterPwr: stats.master ? stats.master.gpu_pwr : 0,
                masterTemp: stats.master ? stats.master.gpu_temp : 0,
                masterGpuUtil: stats.master ? stats.master.gpu_util : 0,
                masterCpuUtil: stats.master ? stats.master.cpu_util : 0,
                workerPwr: workerReporting ? stats.worker.gpu_pwr : 0,
                workerTemp: workerReporting ? stats.worker.gpu_temp : 0,
                netMbps: parseFloat(sessionData.netThroughput) || 0
            };
            responseMetrics.push(snap);
            if (hwChartInst) {
                const labels = responseMetrics.map((_, i) => i);
                hwChartInst.data.labels = labels;
                hwChartInst.data.datasets[0].data = responseMetrics.map(s => s.masterPwr);
                hwChartInst.data.datasets[1].data = responseMetrics.map(s => s.workerPwr);
                hwChartInst.data.datasets[2].data = responseMetrics.map(s => s.masterTemp);
                hwChartInst.data.datasets[3].data = responseMetrics.map(s => s.masterGpuUtil);
                hwChartInst.data.datasets[4].data = responseMetrics.map(s => s.netMbps);
                hwChartInst.update('none');
            } else if (responseMetrics.length >= 2 && hwChartContainer) {
                hwChartContainer.classList.remove('hidden');
                hwChartInst = new Chart(hwChartCanvas.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: responseMetrics.map((_, i) => i),
                        datasets: [
                            { label: 'M-GPU W', data: responseMetrics.map(s => s.masterPwr), borderColor: 'rgba(250,204,21,0.9)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: 'y' },
                            { label: 'W-GPU W', data: responseMetrics.map(s => s.workerPwr), borderColor: 'rgba(248,113,113,0.9)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: 'y' },
                            { label: 'M-Temp °C', data: responseMetrics.map(s => s.masterTemp), borderColor: 'rgba(251,146,60,0.7)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.3, borderDash: [3,3], yAxisID: 'y2' },
                            { label: 'GPU Util %', data: responseMetrics.map(s => s.masterGpuUtil), borderColor: 'rgba(167,139,250,0.7)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.3, borderDash: [3,3], yAxisID: 'y2' },
                            { label: 'Net MB/s', data: responseMetrics.map(s => s.netMbps), borderColor: 'rgba(52,211,153,0.8)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: 'y' }
                        ]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
                        interaction: { intersect: false, mode: 'index' },
                        plugins: { legend: { display: true, labels: { color: '#6b7280', font: { size: 9 }, boxWidth: 10, padding: 6 } } },
                        scales: {
                            x: { display: false },
                            y: { position: 'left', grid: { color: 'rgba(55,65,81,0.4)' }, ticks: { color: '#6b7280', font: { size: 9 } } },
                            y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#6b7280', font: { size: 9 } }, min: 0, max: 100 }
                        }
                    }
                });
            }
        }
    } catch (e) {
        console.error('pollTelemetry error:', e);
        document.getElementById('worker-status-badge').innerText = 'ERROR';
        document.getElementById('worker-status-badge').className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-red-900/50 text-red-400';
        document.getElementById('worker-status-badge').title = 'Telemetry polling error: ' + (e.message || String(e));
    }
}

function setTelemetryInterval(ms) {
    if (telemetryInterval) clearInterval(telemetryInterval);
    telemetryInterval = setInterval(pollTelemetry, ms);
}
setTelemetryInterval(1000);

document.getElementById('polling-rate').addEventListener('change', (e) => {
    setTelemetryInterval(parseInt(e.target.value));
});

// --- Chat History UI ---
function buildStaticTimelineSvg(msg) {
    if (!msg.prefillMetrics) return '';
    const pTime = parseFloat(msg.prefillMetrics.time) || 0;
    const tTime = parseFloat(msg.thinkMetrics?.time || 0) || 0;
    const aTime = parseFloat(msg.answerMetrics?.time || 0) || 0;
    const total = pTime + tTime + aTime || 1;
    const VB_W = 1000, VB_H = 100, MID = 50;
    const pEnd = (pTime / total) * VB_W;
    const tEnd = pEnd + (tTime / total) * VB_W;
    const aEnd = tEnd + (aTime / total) * VB_W;

    let prefillPoints = `0,${MID} ${pEnd.toFixed(1)},${MID}`;
    const samples = (msg.prefillSamples || []).filter(s => !isNaN(s.tps) && !isNaN(s.progress));
    if (samples.length > 0) {
        const tpsVals = samples.map(s => s.tps);
        const maxTps = Math.max(...tpsVals, 1);
        const minTps = Math.min(...tpsVals, maxTps);
        const range = Math.max(maxTps - minTps, 1);
        prefillPoints = samples.map(s => {
            const x = s.progress * pEnd;
            const y = VB_H - 10 - (((s.tps - minTps) / range) * (VB_H - 20));
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
    }
    const thinkPoints = tTime > 0 ? `${pEnd.toFixed(1)},${MID} ${tEnd.toFixed(1)},${MID}` : '';
    const answerPoints = aTime > 0 ? `${tEnd.toFixed(1)},${MID} ${aEnd.toFixed(1)},${MID}` : '';

    return `
        <div class="timeline-graph-wrap w-full h-6 rounded-md bg-gray-800 overflow-hidden mb-1">
            <svg class="timeline-graph-svg w-full h-full" viewBox="0 0 1000 100" preserveAspectRatio="none">
                <polyline points="${prefillPoints}" fill="none" stroke="#eab308" stroke-width="6" />
                <polyline points="${thinkPoints}" fill="none" stroke="#3b82f6" stroke-width="6" />
                <polyline points="${answerPoints}" fill="none" stroke="#22c55e" stroke-width="6" />
            </svg>
        </div>`;
}

function renderChatSession(messages, scrollToIndex = -1) {
    const chatBox = document.getElementById('chat-container');
    chatBox.innerHTML = '';
    
    if (!messages || messages.length === 0) {
        chatBox.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <svg class="w-12 h-12 mb-3 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>
            Cluster Offline. Boot the server to begin.
        </div>`;
        return;
    }

    messages.forEach((msg, idx) => {
        const ts = msg.timestamp || '';
        if (msg.role === 'user') {
            chatBox.innerHTML += `
                <div id="msg-${idx}" class="msg-wrapper p-4 rounded-xl border border-gray-700 bg-gray-800 max-w-4xl mx-auto shadow-sm w-full mb-4">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-xs text-gray-300 uppercase">User</div>
                        <div class="flex items-center gap-3">
                            <div class="text-[10px] text-gray-500">${ts}</div>
                            <button class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors" data-mode="rendered" data-raw="${escapeHtml(msg.content)}" onclick="toggleRaw(this, false)">View Raw</button>
                        </div>
                    </div>
                    <div class="msg-content text-sm text-gray-100 whitespace-pre-wrap overflow-x-auto break-words">${escapeHtml(msg.content)}</div>
                </div>
            `;
        } else if (msg.role === 'assistant') {
            chatBox.innerHTML += `
                <div id="msg-${idx}" class="msg-wrapper p-5 rounded-xl border border-indigo-900/30 bg-gray-900 max-w-4xl mx-auto shadow-sm w-full mb-4">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-xs text-indigo-400 uppercase tracking-wider">Assistant</div>
                        <div class="flex items-center gap-3">
                            <div class="text-[10px] text-gray-500">${ts}</div>
                            <button class="raw-btn text-[10px] text-gray-500 hover:text-gray-300 transition-colors" data-mode="rendered" data-raw="${escapeHtml(msg.content)}" onclick="toggleRaw(this, true)">View Raw</button>
                        </div>
                    </div>
                    ${msg.prefillMetrics ? `
                    <div class="metrics-timeline-container w-full mb-3 mt-2">
                        ${buildStaticTimelineSvg(msg)}
                        <div class="flex text-[9px] text-gray-500 gap-4 px-1">
                            <div class="label-prefill text-yellow-500/80 font-mono">Prefill: <span class="val text-gray-200">${msg.prefillMetrics.time}s | ${msg.prefillMetrics.tokens}t | ${msg.prefillMetrics.tps} t/s</span></div>
                            ${msg.thinkMetrics ? `<div class="label-think text-blue-500/80 font-mono">Think: <span class="val text-gray-200">${msg.thinkMetrics.time}s | ${msg.thinkMetrics.tokens}t | ${msg.thinkMetrics.tps} t/s</span></div>` : ''}
                            ${msg.answerMetrics ? `<div class="label-answer text-green-500/80 font-mono">Answer: <span class="val text-gray-200">${msg.answerMetrics.time}s | ${msg.answerMetrics.tokens}t | ${msg.answerMetrics.tps} t/s</span></div>` : ''}
                        </div>
                        ${(msg.responseMetrics && msg.responseMetrics.length >= 2) ? `<div class="hw-history-chart-wrapper mt-2 border border-gray-800/60 rounded-lg bg-gray-950/50 p-1" style="height:90px"><canvas class="hw-history-chart" data-metrics='${JSON.stringify(msg.responseMetrics).replace(/'/g, "&#39;")}'></canvas></div>` : ''}
                    </div>
                    ` : ''}
                    ${msg.reasoning ? `
                    <div class="reasoning-container border border-gray-800 rounded-lg bg-gray-950/50 mb-3 mt-2">
                        <div class="flex justify-between px-3 py-1.5 bg-gray-800/30 text-[10px] text-gray-400 border-b border-gray-800 cursor-pointer hover:bg-gray-800/50 transition-colors" onclick="toggleReasoning(this)">
                            <span>🧠 Reasoning Trace <span class="r-tokens text-gray-500 ml-1">(~${Math.ceil(msg.reasoning.length/4)} tokens)</span></span>
                            <span class="r-icon">▲</span>
                        </div>
                        <div class="reasoning-body text-xs text-gray-500 font-mono p-3 overflow-x-auto overflow-y-hidden relative cursor-pointer" onclick="toggleReasoning(this.previousElementSibling)">${escapeHtml(msg.reasoning)}</div>
                    </div>
                    ` : ''}
                    <div class="msg-content prose prose-invert max-w-none text-sm overflow-x-auto break-words">${marked.parse(msg.content)}</div>
                </div>
            `;
        }
    });
    
    setTimeout(() => {
        if (scrollToIndex >= 0) {
            const target = document.getElementById(`msg-${scrollToIndex}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            chatBox.scrollTop = chatBox.scrollHeight;
        }
        // Hydrate saved hardware telemetry charts from stored data
        chatBox.querySelectorAll('.hw-history-chart').forEach(canvas => {
            try {
                const metrics = JSON.parse(canvas.dataset.metrics);
                if (!metrics || metrics.length < 2) return;
                new Chart(canvas.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: metrics.map((_, i) => i),
                        datasets: [
                            { label: 'M-GPU W', data: metrics.map(s => s.masterPwr), borderColor: 'rgba(250,204,21,0.9)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: 'y' },
                            { label: 'W-GPU W', data: metrics.map(s => s.workerPwr), borderColor: 'rgba(248,113,113,0.9)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: 'y' },
                            { label: 'M-Temp °C', data: metrics.map(s => s.masterTemp), borderColor: 'rgba(251,146,60,0.7)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.3, borderDash: [3,3], yAxisID: 'y2' },
                            { label: 'GPU Util %', data: metrics.map(s => s.masterGpuUtil), borderColor: 'rgba(167,139,250,0.7)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.3, borderDash: [3,3], yAxisID: 'y2' },
                            { label: 'Net MB/s', data: metrics.map(s => s.netMbps), borderColor: 'rgba(52,211,153,0.8)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: 'y' }
                        ]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
                        interaction: { intersect: false, mode: 'index' },
                        plugins: { legend: { display: true, labels: { color: '#6b7280', font: { size: 9 }, boxWidth: 10, padding: 6 } } },
                        scales: {
                            x: { display: false },
                            y: { position: 'left', grid: { color: 'rgba(55,65,81,0.4)' }, ticks: { color: '#6b7280', font: { size: 9 } } },
                            y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#6b7280', font: { size: 9 } }, min: 0, max: 100 }
                        }
                    }
                });
            } catch(e) {}
        });
    }, 50);
}

function renderChatHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    
    allChatSessions.sort((a,b) => b.id - a.id).forEach(session => {
        const date = new Date(parseInt(session.id)).toLocaleString();
        
        const wrapper = document.createElement('div');
        wrapper.className = 'border border-gray-700/50 rounded-md bg-gray-850 overflow-hidden';
        
        const header = document.createElement('div');
        header.className = 'p-2 cursor-pointer hover:bg-gray-800 text-indigo-300 font-medium flex justify-between items-center';
        header.innerHTML = `<span>Session: ${date}</span><span class="text-[10px] text-gray-500">${session.messages.length / 2} pairs</span>`;
        
        const msgList = document.createElement('div');
        msgList.className = 'hidden flex-col divide-y divide-gray-700/30 bg-gray-900 border-t border-gray-700/50';
        
        session.messages.filter(m => m.role === 'user').forEach(msg => {
            const row = document.createElement('div');
            row.className = 'p-2 pl-4 text-[10px] text-gray-400 truncate hover:text-gray-200 cursor-pointer';
            row.innerText = msg.content;
            row.onclick = () => { 
                if (session.id !== currentSessionId) {
                    currentSessionId = session.id;
                    chatContext = [...session.messages];
                }
                const realIdx = session.messages.findIndex(m => m === msg);
                renderChatSession(session.messages, realIdx);
            };
            msgList.appendChild(row);
        });
        
        header.onclick = () => {
            msgList.classList.toggle('hidden');
            msgList.classList.toggle('flex');
            if (session.id !== currentSessionId) {
                currentSessionId = session.id;
                chatContext = [...session.messages];
                renderChatSession(chatContext, -1);
            }
        };
        
        wrapper.appendChild(header);
        wrapper.appendChild(msgList);
        list.appendChild(wrapper);
    });
}

function saveChatSession() {
    const existingIndex = allChatSessions.findIndex(s => s.id === currentSessionId);
    const session = { id: currentSessionId, messages: [...chatContext] };
    if (existingIndex > -1) {
        allChatSessions[existingIndex] = session;
    } else {
        allChatSessions.push(session);
    }
    localStorage.setItem('cluster_chat_history', JSON.stringify(allChatSessions));
    renderChatHistory();
}

try {
    const saved = localStorage.getItem('cluster_chat_history');
    if (saved) { allChatSessions = JSON.parse(saved); renderChatHistory(); }
} catch(e) {}

document.getElementById('btn-clear-history').addEventListener('click', () => {
    if(confirm("Clear all chat history?")) {
        allChatSessions = [];
        chatContext = [];
        currentSessionId = Date.now().toString();
        localStorage.removeItem('cluster_chat_history');
        document.getElementById('chat-container').innerHTML = `<div class="flex flex-col items-center justify-center h-full text-gray-600 text-sm" id="empty-state"><svg class="w-12 h-12 mb-3 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>Cluster Offline. Boot the server to begin.</div>`;
        renderChatHistory();
    }
});

// --- New Chat button ---
document.getElementById('btn-new-chat').addEventListener('click', () => {
    if (chatContext.length > 0) saveChatSession();
    chatContext = [];
    currentSessionId = Date.now().toString();
    document.getElementById('chat-container').innerHTML = `<div class="flex flex-col items-center justify-center h-full text-gray-600 text-sm" id="empty-state"><svg class="w-12 h-12 mb-3 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>New chat started. Type your prompt below.</div>`;
    updateContextUI(0, currentContextLimit);
    document.getElementById('input-token-count').innerText = '~0 tokens';
});

// --- CSV Viewer ---
document.getElementById('btn-view-csv').addEventListener('click', async () => {
    const modal = document.getElementById('csv-modal');
    const thead = document.querySelector('#csv-table thead');
    const tbody = document.querySelector('#csv-table tbody');
    
    thead.innerHTML = ''; tbody.innerHTML = '';
    modal.classList.remove('hidden'); modal.classList.add('flex');
    
    try {
        const res = await fetch('/api/logs/csv');
        if(!res.ok) throw new Error('No logs found');
        const text = await res.text();
        
        const rows = text.trim().split('\n').map(r => r.split(','));
        if (rows.length === 0) return;
        
        // Headers
        const trH = document.createElement('tr');
        rows[0].forEach(h => { const th = document.createElement('th'); th.className = 'px-3 py-2 font-semibold bg-gray-800'; th.innerText = h; trH.appendChild(th); });
        thead.appendChild(trH);
        
        // Data
        rows.slice(1).forEach(r => {
            const tr = document.createElement('tr');
            r.forEach(c => { const td = document.createElement('td'); td.className = 'px-3 py-2'; td.innerText = c; tr.appendChild(td); });
            tbody.appendChild(tr);
        });
    } catch(e) {
        tbody.innerHTML = `<tr><td class="p-4 text-center text-red-400">Failed to load CSV: ${e.message}</td></tr>`;
    }
});
document.getElementById('close-csv-btn').addEventListener('click', () => {
    const modal = document.getElementById('csv-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
});

// --- Expand Chart Modal ---
window.chartEvents = [];
let expandedChartInst = null;
window.expandChart = function(chartId, title) {
    const modal = document.getElementById('expand-modal');
    const titleEl = document.getElementById('expand-modal-title');
    const canvas = document.getElementById('expandedChartCanvas');
    
    titleEl.innerText = title;
    modal.classList.remove('hidden'); modal.classList.add('flex');
    
    // Re-render chart with full history
    let fullLabels = [];
    let fullData0 = [];
    let fullData1 = [];
    
    if (chartId === 'tempChart') { fullLabels = tempHistory.map(h=>h.time); fullData0 = tempHistory.map(h=>h.master); fullData1 = tempHistory.map(h=>h.worker); }
    else if (chartId === 'pwrChart') { fullLabels = pwrHistory.map(h=>h.time); fullData0 = pwrHistory.map(h=>h.master); fullData1 = pwrHistory.map(h=>h.worker); }
    else if (chartId === 'cpuChart') { fullLabels = cpuHistory.map(h=>h.time); fullData0 = cpuHistory.map(h=>h.master); fullData1 = cpuHistory.map(h=>h.worker); }
    else if (chartId === 'gpuUtilChart') { fullLabels = gpuUtilHistory.map(h=>h.time); fullData0 = gpuUtilHistory.map(h=>h.master); fullData1 = gpuUtilHistory.map(h=>h.worker); }
    else if (chartId === 'cpuTempChart') { fullLabels = cpuTempHistory.map(h=>h.time); fullData0 = cpuTempHistory.map(h=>h.master); fullData1 = cpuTempHistory.map(h=>h.worker); }
    else return;

    setTimeout(() => {
        if (expandedChartInst) { expandedChartInst.destroy(); }
        
        const verticalLinePlugin = {
            id: 'verticalLines',
            afterDraw: chart => {
                const ctx = chart.ctx;
                const xAxis = chart.scales.x;
                const yAxis = chart.scales.y;
                if (!xAxis || !yAxis) return;
                window.chartEvents.forEach(evt => {
                    const x = xAxis.getPixelForValue(evt.time);
                    if (x >= xAxis.left && x <= xAxis.right) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(x, yAxis.top);
                        ctx.lineTo(x, yAxis.bottom);
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = evt.color;
                        ctx.setLineDash([5, 5]);
                        ctx.stroke();
                        ctx.fillStyle = evt.color;
                        ctx.font = '12px monospace';
                        ctx.fillText(evt.label, x + 5, yAxis.top + 15 + (evt.offset || 0));
                        ctx.restore();
                    }
                });
            }
        };

        expandedChartInst = new Chart(canvas.getContext('2d'), {
            type: 'line',
            plugins: [verticalLinePlugin],
            data: {
                labels: fullLabels,
                datasets: [
                    {
                        label: 'Master',
                        data: fullData0,
                        borderColor: 'rgba(250, 204, 21, 1)',
                        backgroundColor: 'rgba(250, 204, 21, 0.1)',
                        fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2
                    },
                    {
                        label: 'Worker',
                        data: fullData1,
                        borderColor: 'rgba(248, 113, 113, 1)',
                        backgroundColor: 'rgba(248, 113, 113, 0.1)',
                        fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                interaction: { intersect: false, mode: 'index' },
                plugins: { legend: { display: true, labels: { color: '#9ca3af' } } },
                scales: {
                    x: { display: false },
                    y: { grid: { color: 'rgba(55, 65, 81, 0.5)' }, ticks: { color: '#9ca3af' } }
                }
            }
        });
    }, 50);
};

// --- Sidebar Resizer ---
const resizer = document.getElementById('sidebar-resizer');
const sidebar = document.getElementById('telemetry-sidebar');
let isResizing = false;

resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
});
window.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = document.body.clientWidth - e.clientX;
    if (newWidth > 200 && newWidth < 1200) {
        sidebar.style.width = newWidth + 'px';
    }
});
window.addEventListener('mouseup', () => {
    if(isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { localStorage.setItem('cluster_sidebar_width', sidebar.style.width); } catch(e){}
    }
});

try {
    const savedWidth = localStorage.getItem('cluster_sidebar_width');
    if (savedWidth) sidebar.style.width = savedWidth;
} catch(e) {}
