# Phase 5 React feature slices

Scope: replace script.js and index.html behavior. Frozen types: shared/contracts.ts. Four tabs: tab-interactive, tab-monitor, tab-history, tab-bench (index.html:490-493).

## Boot sequence

|Order|Action|Lines|
|-|-|-|
|1|Script executes after body; declares state; clears cluster_averages.|script.js:1-103; index.html:1139|
|2|Creates six Chart.js charts; binds launch field listeners.|139-273|
|3|Starts models, builds, device discovery and history summary.|276-424|
|4|Opens SSE; installs watchdog and unload cleanup.|429-443; call 727|
|5|Restores launch config; binds profiles/preview/start controls.|732-1138|
|6|Binds chat, worker, devices, telemetry, tabs, bench, resize and A/B; starts worker and telemetry polls; restores UI storage.|1345-5346|

React boot: one cleanup registry. Mount first, then SSE/polls. Abort fetches and clear all timers on unmount. Create charts after canvas mount.

## SSE client

GET /api/status. connectSSE creates EventSource and assigns handleSseMessage (429-433). Watchdog runs each 15 s, reconnects only visible tab stale over 45 s (434-442). beforeunload closes it (443). Each message updates lastSseAt, server state, model, command, config (465-472). Catch malformed JSON in React; vanilla throws.

|data.log prefix|Handler|Lines|Slice|
|-|-|-|-|
|PREFILL_PROGRESS:|handlePrefillProgress|486-493; 1497-1543|3, 4|
|GEN_PROGRESS:|handleGenProgress|494-501; 1554-1575|3, 4|
|COMPLETION:|handleMonitorCompletion; saveMetricsToAverages|502-521; 4181-4237; 105-128|4, 5, 6|
|CTX_LIVE:|updateContextUI|523-530; 129-138|3, 4|
|BENCH_DONE:|stop progress; set row status|531-539|6|
|BENCH:|appendBenchLine|540-542; 4479-4499|6|
|state only|engine, boot, chat, control state|545-727|1, 2, 3, 4, 7|

Error channel: data.error. LAUNCH CMD: informational only; any other error updates lastKnownServerError (478-485).

## Cross-slice globals

|State, declaration|Read/write slices|React decision / risk|
|-|-|-|
|eventSource, lastSseAt 427-428; lastKnownServerState/error 5079-5080|1,2,3,6|single server store; shell only SSE owner|
|isModelLoaded, currentLoadTime, lastLaunchCommand, lastKnownLaunchConfig 36-37,446-464|1,2,3,4,6|server store; readiness never inferred locally|
|models/builds/device promises; snap generation 295,315,327,338-348|2,6,9|launch store; retain stale-response guard|
|telemetry histories/charts/poll state 31-37,219-231,1434,2481-2497,2930|3,4,5,6|telemetry store; chart refs local|
|runningAverages/context 59-70; completion state 4176-4180|3,4,5,6|request metrics store; COMPLETION source of truth|
|worker intervals 53,2120-2121,2272-2273|2,7|worker slice owns cleanup|
|omni chart state 3260-3962|3,4,5,6|shared chart helpers, never shared Chart instance|
|bench output/queue 4370-4832; A/B 5081-5083|2,6|bench store; A/B depends on launch and SSE|

## 1. App shell, navigation, status banner, error display

**Components:** AppShell layout/cleanup; TabNav view select; EngineStatusBanner state; ServerErrorSurface fatal launch error; SidebarLayout resize/collapse.

**DOM owned:** launch-sidebar, telemetry-sidebar, left-resizer, sidebar-resizer, toggle-left-sidebar, toggle-right-sidebar; tab-interactive/tab-monitor/tab-history/tab-bench; engine-status, boot-timer, boot-overlay/boot-timer-display/boot-status-text/boot-progress-fill; interactive, monitor-view, history-view, bench-view roots.

**Replace functions:** connectSSE 429-448; state half handleSseMessage 465-731; setTabButtonActive 4305-4376; setSidebarCollapsed 5051-5084; resize listeners 5014-5047.

**API/SSE:** GET /api/status; state, error, LAUNCH CMD:. **Timers:** watchdog 438-442; boot 100 ms 551-573; delayed VRAM 665; delayed ready 718.

**Storage:** cluster_sidebar_width and launch_sidebar_width raw CSS width strings; sidebar_collapsed_left/right is 1 collapsed, empty open (5043-5072).

**States:** stopped, starting, loading, stopping, ready; boot overlay; error bubble; mobile hidden sidebars. **Keyboard/ARIA:** native buttons only today. Add tablist/tab/tabpanel, Arrow/Home/End roving focus; keyboard resize and aria labels.

**Gotchas:** vanilla handler writes child DOM. Shell must dispatch typed state only. launchConfig flows once to slice 2 behind hasAppliedServerConfig (899-914).

## 2. Build, model, device, launch, command preview, start, stop controls

**Components:** LaunchConfigPanel reducer; ModelBuildSelectors loaders; DevicePicker; LaunchPreview plus FlagReferenceDialog; LaunchProfiles; LaunchControls.

**DOM owned:** hardware-config-section and controls model-select, build-select, device-detect-status, device-dropdown-row, device-manual-row, device-select-a/b, device-manual-a/b, rpc-toggle, worker-ssh, worker-ssh-controls, transport-type, server-tensor-split, ts-val-display, spec-type-cb, spec-options, spec-ngram-options, advanced-panel/icon/toggle, extra-args, raw-launch-command/status, flag modal ids, profile controls, btn-start-server, btn-stop-server, historical-stats.

**Replace functions:** fetchModels 276-300; fetchBuilds 301-348; snapToLastUsedConfig 349-379; loadHistoricalStats 380-428; setHardwareConfigLocked 449-464; save/apply/restore/populate/build config 732-966; flag functions 967-1058; refreshCommandPreview 1059-1147; profiles 1148-1344; RPC/device functions 2315-2497.

**API/SSE:** GET /api/models, /api/builds, /api/devices?build=, /api/flags?build=, /api/logs/summary; POST /api/preview-command, /api/start, /api/stop; state/error/launch config. **Timers:** preview debounce 1058-1147; delayed preview 904. Snap generation prevents late overwrite.

**Storage:** last_launch_config JSON full config; launch_profiles JSON profile array. Shape comes buildConfigFromUI 915-966; profiles save named config 1159-1294.

**States:** model/build/device loading, error, empty; no selection; preview loading/error; locked engine; profile parse/duplicate/missing; no history. **Keyboard/ARIA:** native labels/selects; flag dialog needs focus trap, Escape, return focus; preview readonly.

**Gotchas:** await models/builds/devices before saved/server config. currentLaunchMode fixed local-multi-gpu (44). Device choice drives worker telemetry and bench/A-B. Preserve stale snap guard.

## 3. Chat streaming and slot polling through server proxy

**Components:** ChatView; ChatComposer; StreamingMessage; ChatSessionList; SlotsPoller.

**DOM owned:** chat-container, empty-state, chat-input-bar, system-prompt, chat-thinking, chat-kwargs, user-prompt, input-token-count, status-indicator, submit-btn, abort-btn, btn-view-csv, btn-clear-history, btn-new-chat, history-list; generated msg-wrapper/user-msg/assistant-msg and message classes.

**Replace functions:** toggle/raw/reasoning/collapse helpers 1367-1451; live/progress/timeline 1452-1624; submitPrompt 1625-2124; session render/save 2954-3196 except CSV parser/dialog belongs slice 5.

**API/SSE:** current direct localhost:8080/v1/chat/completions streaming and /slots 1794-1814,1882. React must call server proxy, never browser direct host. POST /api/log; SSE progress/context/completion/state. **Timers:** slots and TPS intervals 1794-1819; scroll timeout 3060.

**Storage:** cluster_chat_history JSON allChatSessions; malformed removes key (3154-3196).

**States:** engine unavailable; empty; streaming prefill/thinking/answer; abort; malformed kwargs; proxy/network/reader errors; collapsed long output. **Keyboard/ARIA:** Enter sends, Shift+Enter newline; send/abort focus and disabled rules; aria-live polite stream; no forced scroll after user scroll-up.

**Gotchas:** abortController global allows one request. Completion comes from any client; draft stats expiry guard avoids wrong bubble (4181+). Do not duplicate completion metrics after POST /api/log.

## 4. Telemetry cards, live charts, chart expansion, sampling controls

**Components:** TelemetrySidebar; MetricCards; MiniCharts; TelemetryPoller; ChartExpandDialog; OmniChart; SamplingRateSelect.

**DOM owned:** polling-rate, telemetry-failure-banner/count; all metric/context/VRAM/RAM/current-* ids; netChart/tpsChart/tempChart/pwrChart/cpuChart/gpuUtilChart/cpuTempChart; expand-modal/title/expandedChartCanvas/time controls; omni-smooth-cb.

**Replace functions:** averages/context/chart creation 72-260; pollTelemetry 2498-2930; setTelemetryInterval 2931-2953; expand/omni 3268-3962.

**API/SSE:** GET /api/telemetry/latest, /api/logs/active-samples; POST /api/telemetry/rate; SSE PREFILL_PROGRESS, GEN_PROGRESS, CTX_LIVE, COMPLETION, state. **Timers:** poll 2934; failure hide 2510; chart hover 3685; expand refresh 3407.

**Storage:** cluster_averages JSON {prefillTokens,prefillSeconds,genTokens,genSeconds}, intentionally removed on load/launch/stop; omni_smoothing 1 true, empty false (3522-3537).

**States:** no telemetry; unknown numeric --; worker absent/offline; poll backoff; no chart data; dialog live/history. **Keyboard/ARIA:** replace inline canvas onclick with labeled buttons; dialog focus/Escape/return focus; range/zoom labels.

**Gotchas:** telemetry stats is Record<string,unknown>. poll in-flight guard. currentTelemetryRateMs drives Monitor cadence. Histories unbounded now; set cap before long sessions.

## 5. Monitor and history tables, filters, summaries, sample detail, CSV download

**Components:** MonitorView; HistoryView; RequestTable; RequestSampleDialog; CsvLogDialog; HistorySummary.

**DOM owned:** monitor-view, session-omni-card/sessionOmniChart/monitorTpsChart/monitor-requests-body/monitor-requests-empty; history-view/history-chart-status/historyTpsChart/history-requests-body/history-requests-empty; csv-modal/close-csv-btn/csv-table and their filters.

**Replace functions:** parseCSVLine 3197-3267; monitor/history 3963-4304; sample expansion 3907-3962; renderRequestTable 3996-4054.

**API/SSE:** GET /api/logs/recent?limit=200, /api/logs/samples?runId=, /api/logs/active-samples, /api/logs/csv, /api/logs/summary?model=&transport=; SSE COMPLETION. **Timers:** monitor omni 4158-4168 only active tab; sample detail refresh 3938-3962.

**Storage:** none. **States:** monitor empty; history loading/empty/error/filter empty; samples evicted/missing; CSV loading/404/parse error; live row. **Keyboard/ARIA:** rows must use buttons not inline click; modal focus/Escape; live refresh must not steal focus.

**Gotchas:** Monitor never backfills. History refetches on visit. Samples max 30, RAM-only, lost restart. Remove window click caches.

## 6. Benchmark runner, matrix queue, notes, restore, stop, telemetry graph

**Components:** BenchView; BenchForm; MatrixQueue; BenchOutput; BenchProgress; BenchTelemetryGraph; LaunchSweep; BenchSubtabs.

**DOM owned:** every bench-* under bench-view: subtabs/cards/form, bench-run/stop/run-queued, queue controls, benchOmniChart/reset, restore/clear/output; all ab-* and ab-results-body.

**Replace functions:** bench 4377-5050; A/B 5075-5346.

**API/SSE:** GET /api/builds, /api/models, /api/devices?build=, /api/bench/status, /api/logs/active-samples, /api/master/logs; POST /api/bench/start,/stop,/clear,/restore,/dequeue,/note, /api/start,/api/stop. Move A/B direct localhost completion request behind proxy. SSE BENCH:, BENCH_DONE:, COMPLETION, state/error.

**Timers:** output 200 ms 4504-4509; omni poll 4534-4551; progress 1 s 4563-4580; A/B poll 5223-5231, stop wait 5251-5252, completion timeout 5283.

**Storage:** bench_auto_queue JSON queue/null; bench_stars JSON object; bench_custom_rows JSON rows; bench_row_status JSON label status object; launch_ab JSON {rows,prompt,genTokens,reps}; bench_subtab hw or server. Lines 4447,4674-4683,4813-4835,4977-5008,5085-5105,5342-5346.

**States:** lazy init; build/model/device error/empty; bad manual line; no matrix selection; running/queued/stopped/failed; output empty/restored/cleared; sweep missing prompt/rows/ready/completion timeout. **Keyboard/ARIA:** subtab semantics; queue buttons native; graph opens dialog by keyboard.

**Gotchas:** hardware queue server-owned after submit. A/B owns engine lifecycle and shared SSE completion resolver; cannot overlap normal launch/chat. benchModelsCache only loads after Bench open but A/B parser needs it.

## 7. Worker setup, lifecycle controls, status, logs

**Components:** WorkerConnectionPanel; WorkerLifecycleControls; WorkerStatusBadge; ServerLogsPanel.

**DOM owned:** worker-ssh, worker-ssh-controls, transport-type, worker-status-badge, worker controls; master-logs-container/btn-master-logs-toggle/master-logs-icon/body/pre; worker-logs equivalents.

**Replace functions:** updateWorkerStatus 2125-2179; fetchWorkerLogs 2180-2274; fetchMasterLogs 2275-2314; listeners 2200-2314.

**API/SSE:** POST /api/worker/start,/worker/stop,/worker/status,/worker/logs; GET /api/master/logs; state/error styles. **Timers:** status 5 s starts 2472; logs 3 s only expanded 2263,2300; clear collapse/unmount.

**Storage:** none; worker SSH comes launch config. **States:** RPC disabled; running/stopped/offline; pending/success/error; unopened/loading/no logs/failure; fatal engine error red style. **Keyboard/ARIA:** disclosures aria-expanded/controls, preserve selectable pre, announce operation result.

**Gotchas:** slice 2 owns worker config field and locks it. Transport listener changes default SSH (234-242); slice 7 operates, not owns config.

## 8. Hugging Face search and Markdown rendering

**Components:** HuggingFaceSearchDialog; HfResultList; MarkdownMessage; ReasoningDisclosure.

**DOM owned:** hf-modal/hf-search-input/hf-results; generated result controls; markdown-body/raw/reasoning/collapse classes in chat messages.

**Replace functions:** openHFModal 1345; closeHFModal 1346; searchHF 1347-1366; toggleRaw 1367-1382; toggleReasoning 1383-1402; collapse functions 1403-1451.

**API/SSE:** external GET https://huggingface.co/api/models?search=...&sort=downloads&direction=-1&limit=10. No dashboard API/SSE. Proxy only after the dashboard routes gain one; preserve direct request until then. **Timers/storage:** none.

**States:** unopened, empty query, loading, empty results, external error; markdown raw/expanded/reasoning. **Keyboard/ARIA:** focus trap/Escape/return focus; Enter search; aria-expanded. Sanitize Markdown: vanilla marked.parse plus HTML insertion unsafe; no unsafe HTML without sanitizer.

**Gotchas:** slice 3 owns message lifecycle. Export pure renderer/components. Selecting HF result invokes slice 2 model refresh/select.

## 9. Browser persistence for profiles, chat sessions, chart settings, benchmark drafts

**Components:** useLocalStorageState parse fallback; PersistenceHydrator; optional non-blocking storage warning.

|Key|Current serialization|
|-|-|
|last_launch_config|JSON full config, 732-739/878-898|
|launch_profiles|JSON profile array, 1147-1158|
|cluster_chat_history|JSON allChatSessions; malformed removed, 3154-3196|
|omni_smoothing|1 true, empty false, 3522-3537|
|bench_auto_queue|JSON queue/null; removed on resume, 4447/4813-4815|
|bench_stars|JSON object, 4674-4683|
|bench_custom_rows|JSON array, 4824-4832|
|bench_row_status|JSON label status object, 4831-4835|
|launch_ab|JSON {rows,prompt,genTokens,reps}, 5085-5105|
|bench_subtab|hw or server, 5342-5346|
|cluster_sidebar_width|raw CSS width string, 5043/5066-5067|
|launch_sidebar_width|raw CSS width string, 5044/5068-5069|
|sidebar_collapsed_left/right|1 collapsed, empty open, 5058/5070-5071|
|cluster_averages|JSON running counters, deliberately session-only, 83-128|

**Replace:** every storage call above plus restore order inside launch/chat/bench/sidebar. **API/SSE/timers:** none. **States:** storage unavailable, JSON parse failure, future schema, quota write failure. Preserve UI; warn non-blocking.

**Gotchas:** no versions. Migration idempotent; retain unknown config fields. Hydrate launch only after models/builds/devices. Hydrate A/B after Bench cache if parser needs models. cluster_averages is not restart persistence.

## Conversion rules

1. First typed stores: server/SSE, launch config, telemetry, persistence.
2. Shell alone opens SSE. Telemetry alone polls telemetry. Worker alone owns worker/log timers. Cleanup on unmount/tab deactivation.
3. Replace inline onclick and window caches with React handlers.
4. shared/contracts.ts is API source. Telemetry remains Record<string,unknown> until contract expands.
