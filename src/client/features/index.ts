// Feature panel registry. App shell renders the registered panels via
// PanelGrid; each panel is self-contained. Slice map: docs/p5-slices.md.
export { default as ChatPanel } from './interactive/ChatPanel';
export { default as MonitorPanel } from './monitor/MonitorPanel';
export { default as LiveRequestsPanel } from './monitor/LiveRequestsPanel';
export { default as LogsPanel } from './logs/LogsPanel';
export { default as FileBrowserPanel } from './files/FileBrowserPanel';
export { default as OverviewPanel } from './overview/OverviewPanel';
export { default as HistoryPanel } from './history/HistoryPanel';
export { default as BenchPanel } from './bench/BenchPanel';
export { default as UpgradePanel } from './upgrade/UpgradePanel';
export { default as PresetDock } from './presets/PresetDock';
export { default as PresetBrowserDialog } from './presets/PresetBrowserDialog';
