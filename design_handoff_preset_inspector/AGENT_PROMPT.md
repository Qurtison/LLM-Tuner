# Paste this to your coding agent

> Adjust the repo path/stack line if you are not building in `llama.cpp/tools/server/webui`.

---

Build a **preset inspector** for llama.cpp settings in `tools/server/webui`
(SvelteKit, Svelte 5 runes, TypeScript, Tailwind, shadcn-svelte primitives in
`src/lib/components/ui/`, feature components in `src/lib/components/app/`, stores in
`src/lib/stores/*.svelte.ts`). Read `design_handoff_preset_inspector/README.md` in full and
open `llama.cpp Preset Panel.dc.html` — build option **1b** only (the middle of the three
columns). 1a and 1c are rejected alternates; ignore them.

The organising idea: **a preset is a diff from llama.cpp's defaults.** The docked 380px
sidebar shows only the settings the user has changed. Everything else lives behind one
"Browse all 214 settings" door (⌘K).

Work in this order and stop for review after each step.

**Step 1 — Parameter registry.**
Write `scripts/gen-params.ts` that parses `llama-server --help` into
`src/lib/data/llama-params.ts` as `ParamDef[]` (interface is in the README). Then hand-correct:
human labels, the 12 task groups, enum option lists, and `scope`.
`scope` is the critical field:
- `request` — sampling, penalties, grammar/json-schema, n_predict, reasoning effort/budget,
  cache_prompt: things that go in the `POST /v1/chat/completions` body.
- `server` — everything launch-time: ctx-size, ngl, cache-type-k/v, split-mode, threads,
  batch, flash-attn, host/port/api-key, tools, mmproj, speculative decoding.
- `archive` — deprecated/removed: mlock, mmap, direct-io, defrag-thold, draft/draft-min,
  spec-ngram-size-n/m/min-hits.
Show me the registry and the group assignments before continuing.

**Step 2 — Store.** `src/lib/stores/presets.svelte.ts`, per the README's State section.
Hard invariant: `preset.values` only ever holds entries that differ from the registry
default; setting a control back to its default deletes the key. Persist with whatever the app
already uses for settings. Unit-test the invariant and the dirty check.

**Step 3 — Docked panel.** `src/lib/components/app/presets/PresetPanel.svelte`,
380px, header / diff list / footer, exactly as the README's Screen 1 describes — including
the empty state and the struck-through default next to each changed value. Hover a row for a
tooltip carrying the flag aliases, the one-line help and the env var; flags are not shown as
labels.

**Step 4 — Settings browser.** `PresetBrowserDialog.svelte`, 860×780, left category rail +
right list, search over label/flags/env/help, `All | Modified | Archive` filter, modified rows
pinned to the top of each group with an amber left border, unmodified rows flat. ⌘K opens it.
Keyboard: ↑↓ ⏎ ⌫ ⇥ Esc.

**Step 5 — Apply & export.**
- `request`-scoped values merge into the chat completion request body.
- `server`-scoped values cannot apply to a running server: show a quiet footer line
  "N settings apply on next server start" and mark those rows. In ROUTER mode, offer reload.
- Export a preset as JSON, and as INI compatible with `--models-preset`. **Never render a
  command-line string anywhere in the UI** — that is a deliberate product decision.

Constraints:
- Use existing shadcn-svelte primitives (Dialog, Command, Input, Switch, ToggleGroup, Select,
  Tooltip, ScrollArea) and the app's Tailwind theme tokens. Keep the token *relationships*
  from the README: three-step text hierarchy, amber as the only "changed from default"
  accent, mono for every value and flag, sans for every human label.
- No component may hardcode a flag name; everything derives from the registry.
- Amber is reserved for "you changed this". Don't use it for hover, focus or emphasis.
- Two user preferences: `showFlagNames` (default off), `showDefaults` (default on).
- Accessibility: keep secondary text at or above `#9296a0`-equivalent contrast (≈6:1);
  every row is reachable and resettable by keyboard.
