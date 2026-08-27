# Handoff: llama.cpp Preset Inspector (diff-first sidebar)

## Overview
A right-docked inspector panel, next to the chat, for building and saving named presets of
llama.cpp settings. Its organising idea: **the docked panel shows only what you have changed
away from defaults** — the preset *is* its diff. All 214 flags remain reachable through a
two-pane browser that opens over the app (⌘K or "Browse all settings").

This is option `1b` from the exploration. Options `1a` (collapsed section rail) and `1c`
(query-only palette) are in the same design file for reference and were not chosen.

## About the design files
`llama.cpp Preset Panel.dc.html` in this bundle is a **design reference created in HTML** —
a static prototype showing intended look, density and behaviour. It is not production code and
should not be copied into the app. Recreate it in the target codebase using that codebase's
existing framework, component library and tokens.

Target codebase (assumed): `llama.cpp/tools/server/webui` — SvelteKit, Svelte 5 runes,
TypeScript, TailwindCSS, shadcn-svelte primitives in `src/lib/components/ui/`, feature
components in `src/lib/components/app/`, state in `src/lib/stores/*.svelte.ts`,
API access in `src/lib/services/`. Use those primitives (Dialog, Command, Input, Switch,
ToggleGroup, Select, Tooltip, ScrollArea) rather than hand-rolled markup, and use the app's
existing Tailwind theme tokens rather than the raw hex values below.

## Fidelity
**High fidelity.** Colours, type, spacing and density in the prototype are final intent.
Where the prototype's palette conflicts with the app's existing dark theme, the app's theme
wins — but keep the *relationships*: three-step text hierarchy, amber as the sole "you changed
this" accent, monospace for every value and flag, sans for every human label.

---

## The single most important implementation decision

The 214 flags are **not one kind of thing**. They split into three scopes, and the UI must
know which is which or the preset will silently fail to apply:

| Scope | Examples | How it applies |
|---|---|---|
| `request` | temperature, top-p, min-p, top-k, repeat penalty, samplers, n_predict, grammar, json_schema, reasoning effort/budget, cache_prompt | Sent in the body of `POST /v1/chat/completions`. Takes effect immediately, per message. |
| `server` | ctx-size, n-gpu-layers, cache-type-k/v, split-mode, tensor-split, flash-attn, threads, batch, host, port, api-key, tools, mmproj, speculative decoding | Launch-time only. Cannot be changed by a running server. A preset can only *export* these, or (in ROUTER mode) trigger a model reload. |
| `archive` | mlock, mmap, direct-io, defrag-thold, draft/draft-min, spec-ngram-size-n/m/min-hits | Deprecated or removed. Show, badge, never offer as new. |

Reflect this in the UI:
- `request` rows edit live and take effect on the next message.
- `server` rows are editable but the panel footer shows a persistent, quiet note:
  *"6 settings need a server restart"* with the affected rows carrying a small restart glyph.
- Saving a preset writes both scopes; **exporting** produces a launch config (JSON, or INI
  compatible with `--models-preset`) for the `server` half. No CLI string is ever shown in the
  UI — that was an explicit product decision.

---

## Data model

Build a **parameter registry** as the single source of truth. Everything in the UI derives
from it; no flag is ever hardcoded into a component.

```ts
// src/lib/data/llama-params.ts
export type ParamScope = 'request' | 'server' | 'archive';
export type ParamGroup =
  | 'speed' | 'memory' | 'context' | 'sampling' | 'model' | 'devices'
  | 'speculative' | 'server' | 'agents' | 'multimodal' | 'chat' | 'logging';

export interface ParamDef {
  id: string;                 // stable key, e.g. 'n_gpu_layers'
  label: string;              // 'GPU layers'  — human label, shown
  flags: string[];            // ['-ngl','--gpu-layers','--n-gpu-layers'] — hover only
  env?: string;               // 'LLAMA_ARG_N_GPU_LAYERS'
  group: ParamGroup;
  scope: ParamScope;
  control: 'int' | 'float' | 'text' | 'toggle' | 'enum' | 'multi-enum' | 'path' | 'list';
  default: unknown;           // the llama.cpp default, verbatim
  defaultLabel?: string;      // 'auto', 'model', 'same as --threads' for non-literal defaults
  min?: number; max?: number; step?: number; unit?: string;
  options?: { value: string; label?: string }[];
  help: string;               // one sentence, from --help
  docUrl?: string;
  deprecated?: { since?: string; replacedBy?: string };
  requiresRestart?: boolean;  // derived: scope === 'server'
}
```

Generate the first pass of this file from `llama-server --help` output — do not hand-type
214 entries. Write a small script that parses the help text into `ParamDef` stubs, then
hand-correct labels, groups and enum option lists.

### Grouping (12 task groups, not CLI sections)
`speed` · `memory` · `context` · `sampling` · `model` · `devices` · `speculative` ·
`server` · `agents` · `multimodal` · `chat` · `logging`, plus `archive` as a pseudo-group
derived from `scope === 'archive'`. Group names shown to the user:
Speed & threads · Memory & VRAM · Context & caching · Output & sampling · Model & source ·
Devices & GPUs · Speculative decoding · Server & network · Agents & tools ·
Multimodal & embeddings · Chat & reasoning · Logging & debug · Archive.

### Preset
```ts
interface Preset {
  id: string;
  name: string;
  values: Record<string, unknown>;   // ONLY non-default entries — this is the diff
  createdAt: number; updatedAt: number;
}
```
`values` never contains a key whose value equals the registry default. Setting a control back
to its default **deletes the key**. This invariant is what makes the docked panel work with no
extra bookkeeping.

## State
Store: `src/lib/stores/presets.svelte.ts`
- `presets: Preset[]` — persisted (localStorage or the existing Dexie DB, follow whichever
  the app already uses for settings).
- `activePresetId: string | null`
- `draft: Record<string, unknown>` — live edits, same diff-only invariant.
- `isDirty = !deepEqual(draft, activePreset.values)`
- Derived: `overridesByGroup`, `overrideCount`, `restartRequiredCount`.
- Actions: `setValue(id, v)` (deletes key if `v === default`), `reset(id)`, `resetGroup(g)`,
  `save()`, `saveAsNew(name)`, `revert()`, `select(id)`, `duplicate(id)`, `remove(id)`,
  `exportPreset(id, 'json' | 'ini')`, `importPreset(file)`.

---

## Screens

### 1 — Docked panel (default state)
**Purpose:** see and adjust the current preset's overrides without leaving the chat.
**Layout:** 380px fixed width, full height, `display:flex; flex-direction:column`, right
border/edge against the chat column. Three regions: header (fixed), diff list (scrolls),
footer (fixed).

**Header** — 15px 16px 14px, 1px bottom hairline.
- Row 1: label `PRESETS`, 9.5px/600 mono, letter-spacing .15em, dim; right-aligned text
  button "Manage" (11px/500 sans).
- Row 2: preset pills, horizontal wrap, 6px gap. Active pill: amber fill `#e9a63c`,
  text `#17181d`, 11px/600, 5px 10px, radius 20px. Inactive: 1px border `#262a34`,
  text `#8d9099`. Last pill: dashed border, `+` — creates a new empty preset.
- Row 3: 6px amber dot, then `14 overrides · unsaved` (11px mono), spacer, "Save"
  (11px/600, amber). The dot and "unsaved" appear only when `isDirty`.

**Diff list** — one block per group that has overrides; groups with none are absent entirely.
- Group heading: `MEMORY & VRAM · 4`, 9.5px/600 mono, .15em tracking, dim, 14px 16px 8px.
- Override row: 8px 16px, `margin-left:14px`, `border-left:2px solid #e9a63c`,
  `padding-left:12px`. Left: human label 12.5px/500 sans. Right: struck-through default
  (11px mono, dim, `text-decoration:line-through`) then the current value (12px/600 mono,
  near-white). Rows with no meaningful default (tensor split, host) omit the struck value.
- Row click → inline edit in place (the control type comes from `ParamDef.control`).
  Backspace/⌫ on a focused row resets it, which removes it from the list with a short
  height+opacity collapse (140ms ease-out).
- Hover a row → tooltip with `flags.join(', ')`, the help sentence, and `env` if present.
  This is the *only* place flag names appear by default (see the `showFlagNames` preference).

**Footer** — 12px 16px, top hairline: full-width secondary button
"Browse all 214 settings" (radius 7px, 1px `#2f3540`, bg `#15181f`), with `⌘K` hint at right.

**Empty state** (no overrides): the diff list is replaced by one centred line —
"Running llama.cpp defaults." plus the same Browse button. Do not fill it with anything else.

### 2 — Settings browser (overlay)
**Purpose:** reach any of the 214 settings, including untouched and deprecated ones.
Opens as a modal over the app at 860×780 max (responsive: full-screen below 900px wide).

**Top bar** — 15px 22px, hairline bottom: search input (flex:1, 12px mono placeholder
"search 214 settings, flags and env vars"), then a segmented filter
`All | Modified 14 | Archive 18`, then close.
Search matches label, flags, env var and help text; results reorder by match quality and
the category rail dims to matching groups.

**Left rail** — 216px, hairline right, 14px vertical padding. One row per group,
8px 20px, 12.5px/500 sans. Rows with overrides show an amber count at the right; rows
without are dimmer and countless. Active row: bg `#171a22`, 2px amber left border, white
text, 600 weight. Archive sits at the bottom, separated by a hairline, with a
`deprecated & removed` caption.

**Right pane** — 20px 26px. Group title (16px/600) + `21 settings` (11px mono) + one-line
group description (12px, max 460px). Then the setting rows:
- **Modified rows float to the top**, styled with bg `#14171e`, radius 7px, 2px amber left
  border, 11px 12px padding.
- Row contents: label (13px/500) with optional flag subline (10.5px mono) when the
  `showFlagNames` preference is on; then the ghosted default (`default auto`, 10.5px mono)
  when `showDefaults` is on; then the control, right-aligned.
- **Unmodified rows** are flat — no background, no border, label at 13px in the secondary
  tier, control right-aligned.
- Controls by type: `enum` → segmented toggle group (amber active segment); long enums
  (cache types, chat templates, spec types) → select; `int`/`float` → mono numeric field,
  with a slider above it when `min`/`max` exist; `toggle` → switch; `path`/`text` → mono input;
  `list` (tensor-split, samplers, device list, lora) → a chip editor.
- Archive rows: 55% opacity, `deprecated` badge in `#c47b5a`, control disabled unless the
  value is already set, and a "replaced by …" link that jumps to the replacement row.

**Footer** — 12px 22px, hairline top: keyboard legend
`↑↓ move · ⏎ edit · ⌫ reset to default` at the left, primary "Save preset" at the right.

### 3 — Preset management
Reached from "Manage". A list of presets with name, override count, updated time, and
row actions: rename, duplicate, export, delete. "Save as new" from the header opens a
one-field name dialog seeded with `<current name> copy`.

---

## Interactions & behaviour
- **⌘K / Ctrl+K** opens the browser with the search field focused, from anywhere in the app.
- **Keyboard in the browser:** ↑↓ move the row cursor, ⏎ enters edit mode on the focused
  control, ⌫ resets to default, ⇥ jumps to the next group, Esc closes (with a confirm only
  if dirty).
- **Reset animation:** row collapses over 140ms `ease-out` (height + opacity). Nothing else
  animates; this panel should feel instant.
- **Dirty state:** amber dot + "unsaved" in the header; Save writes to the active preset,
  Save as new opens the name dialog. Switching presets while dirty prompts once.
- **Restart-required:** any `scope: 'server'` change adds a quiet footer line in the docked
  panel: "6 settings apply on next server start". Never a modal, never a toast.
- **Validation:** numeric fields clamp to `min`/`max` on blur; invalid text (bad JSON schema,
  malformed tensor-split) shows a red 1px border and an inline 11px message under the row —
  saving is still allowed, the preset is a document not a live config.
- **Responsive:** below 900px the docked panel becomes a bottom sheet at 70vh and the
  browser goes full-screen. Below 380px the diff rows stack label over value.

## Design tokens (prototype values — map to the app's theme)
```
Surfaces      panel #0e0f14 · raised #14171e · overlay #14161c · input #15181f / #1a1d25
Hairlines     #1a1d25 (interior) · #1e212a (region) · #262a34 / #2f3540 (control borders)
Text          primary #f2f0eb · label #dedcd7 · secondary #9296a0 · ghost #7c8089
Accent        amber #e9a63c (changed-from-default, active, primary button)
              on-amber text #17181d
Deprecated    #c47b5a
Type          IBM Plex Sans — labels 12.5–13px/500, titles 15–16px/600
              IBM Plex Mono — all values, flags, env vars, counts 10–12px
              section labels 9.5px/600 mono, letter-spacing .15em, uppercase
Radius        4px chips · 5–7px controls · 7px rows · 12px overlay · 20px pills
Spacing       16px panel gutter · 22px overlay gutter · 8–14px row padding
Row heights   diff row ~34px · browser row ~44px
```
Contrast: `#9296a0` ≈ 6:1 and `#7c8089` ≈ 4.6:1 on `#0e0f14` — both pass AA at these sizes.
Do not darken them further when mapping to the app theme.

## Preferences to expose (the design's own tweaks)
- `showFlagNames` (default off) — render the CLI flag as a subline under each label in the
  browser. Off by default because hover already covers it.
- `showDefaults` (default on) — render the ghosted `default …` value on browser rows.

## Assets
None. No icons were drawn: the prototype uses text glyphs (`⌕ ▾ ‹ › ✕ ↺ ⏎ ⌫ ⇥`) as
placeholders. Substitute the app's existing icon set (lucide, as used by shadcn-svelte).

## Files in this bundle
- `llama.cpp Preset Panel.dc.html` — the design reference. Option `1b` is the middle group;
  `1a` and `1c` are alternates, not to be built.
- `AGENT_PROMPT.md` — a paste-ready brief for a coding agent.
