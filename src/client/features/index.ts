// Feature panel registry (Phase 5). App shell renders the active tab's
// panels; each panel is self-contained (own fetches/timers, reads shared
// state via state/server.ts). Slice map: docs/p5-slices.md.
export { default as InteractivePanel } from './interactive/InteractivePanel';
export { default as ChatPanel } from './interactive/ChatPanel';
export { default as WorkerPanel } from './interactive/WorkerPanel';
export { default as HfSearchPanel } from './interactive/HfSearchPanel';
export { default as MonitorPanel } from './monitor/MonitorPanel';
export { default as LiveRequestsPanel } from './monitor/LiveRequestsPanel';
export { default as FileBrowserPanel } from './files/FileBrowserPanel';
export { default as OverviewPanel } from './overview/OverviewPanel';
export { default as HistoryPanel } from './history/HistoryPanel';
export { default as BenchPanel } from './bench/BenchPanel';
export { default as PresetsPanel } from './presets/PresetsPanel';
export { default as UpgradePanel } from './upgrade/UpgradePanel';
