#!/usr/bin/env bun
/**
 * Generate `shared/llama-params.ts` from `llama-server --help`.
 *
 * First pass: parse the binary's help text into ParamDef stubs. Hand-correct
 * labels/groups/options/scope after. See design_handoff_preset_inspector/README.md
 * "Data model" for the schema this produces.
 *
 * Usage:
 *   bun scripts/gen-params.ts [--binary path] [--out path]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);
const HELP_DESC_COLUMN = 40;

// ---------- types ----------

type ParamScope = "request" | "server" | "archive";
type ParamGroup =
  | "speed" | "memory" | "context" | "sampling" | "model" | "devices"
  | "speculative" | "server" | "agents" | "multimodal" | "chat" | "logging"
  | "archive";

type Control = "int" | "float" | "text" | "toggle" | "enum" | "multi-enum" | "path" | "list";

interface ParamDef {
  id: string;
  label: string;
  flags: string[];
  env?: string;
  group: ParamGroup;
  scope: ParamScope;
  control: Control;
  default?: unknown;
  defaultLabel?: string;
  options?: { value: string; label?: string }[];
  runtime?: "device-list";   // control is a list whose length and order come from `llama-server --list-devices`
  help: string;
  deprecated?: { since?: string; replacedBy?: string };
  requiresRestart?: boolean;
}

interface RawEntry {
  flags: string;
  description: string;
  section: string;
  primaryFlag: string;
}

const GROUP_ORDER: ParamGroup[] = [
  "speed", "memory", "context", "sampling", "model", "devices",
  "speculative", "server", "agents", "multimodal", "chat", "logging", "archive",
];

// ---------- help-text parsing ----------

export function parseHelpFlags(helpText: string): RawEntry[] {
  const entries: RawEntry[] = [];
  let section = "general";
  for (const rawLine of helpText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (/^-{3,}.*-{3,}$/.test(trimmed)) {
      section = trimmed.replace(/^-+/, "").replace(/-+$/, "").trim();
      continue;
    }
    if (!trimmed) continue;
    if (!/^\s/.test(line)) {
      const head = line.slice(0, HELP_DESC_COLUMN);
      const [flags, desc] = head.trimEnd().length < HELP_DESC_COLUMN
        ? [head.trim(), line.slice(HELP_DESC_COLUMN).trim()]
        : [line.trim(), ""];
      entries.push({ flags, description: desc, section, primaryFlag: "" });
    } else if (entries.length > 0) {
      const last = entries[entries.length - 1];
      last.description = (last.description ? last.description + " " : "") + trimmed;
    }
  }
  for (const e of entries) {
    const tokens = e.flags.match(/--?[\w-]+/g) ?? [];
    e.primaryFlag = [...tokens].reverse().find((t) => t.startsWith("--")) ?? tokens.at(-1) ?? "";
  }
  return entries;
}

export function extractFlags(flagPart: string): string[] {
  // one flag per comma-segment; ignore value placeholders like "lo-hi" or "<N>"
  return flagPart
    .split(",")
    .map((s) => s.trim().match(/^--?[\w-]+/)?.[0])
    .filter((s): s is string => Boolean(s));
}

export function extractEnv(desc: string): string | undefined {
  const m = desc.match(/\(env:\s*([^)]+)\)/i);
  return m?.[1].trim();
}

const DEFAULT_LITERALS = new Set(["disabled", "enabled", "auto", "none", "all", "true", "false"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toValue(s: string): unknown {
  if (DEFAULT_LITERALS.has(s.toLowerCase())) return s;
  const n = toNumberOrUndefined(s);
  return n !== undefined ? n : s;
}

function toNumberOrUndefined(s: string): number | undefined {
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
}

export function extractDefault(desc: string): { value?: unknown; label?: string } {
  const m = desc.match(/\(default:\s*([^)]+)\)/i);
  if (!m) return {};
  const inside = m[1].trim();
  const unquote = (s: string) =>
    (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
      ? s.slice(1, -1)
      : s;

  // split on the first "value, rest" or "value; rest" — both llama.cpp separators
  const splitRe = /[,;]\s*/;
  const [rawHead, ...rest] = inside.split(splitRe);
  const head = unquote(rawHead.trim());
  const tail = rest.join(", ").trim();

  if (tail) {
    // strip a redundant value echo: "-1, -1 = infinity" → "infinity"
    const echo = new RegExp(`^${escapeRe(head)}\\s*=\\s*`);
    const cleanTail = tail.replace(echo, "");
    return { value: toValue(head), label: cleanTail || undefined };
  }

  // "X = explanation" with no separator
  if (head.includes("=")) {
    const [v, ...labelParts] = head.split("=");
    return { value: toValue(v.trim()), label: labelParts.join("=").trim() || undefined };
  }

  // "same as --foo"  or  a default that is itself another flag  — pure label, no value
  if (head.toLowerCase().startsWith("same as ") || /^-{1,2}[A-Za-z][\w-]*$/.test(head)) return { label: head };
  return { value: toValue(head) };
}

export function extractAllowedValues(desc: string, flagPart: string): string[] | undefined {
  // 1) explicit "allowed values: a, b, c" in the description
  const m = desc.match(/allowed values:\s*([^\n)]+?)(?:\s*$|\s*\()|allowed values:\s*([^\n)]+)$/i);
  if (m) {
    const list = (m[1] ?? m[2]).replace(/\.$/, "").split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  // 2) {a,b,c} braces in description (skip JSON-like with quotes/colons)
  const braces = desc.match(/\{([^}]+)\}/);
  if (braces && !braces[1].includes('"') && !braces[1].includes("'") && !braces[1].includes(":") && braces[1].includes(",")) {
    return braces[1].split(/[,|]/).map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  // 3) flag placeholder: --foo <a|b|c>  or  --foo {a,b,c}  or  --foo [on|off|auto]
  const placeholder = flagPart.match(/[<\[\{](\s*[\w\-|,\s]+)\s*[>\]\}]/);
  if (placeholder) {
    const list = placeholder[1].split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    if (list.length >= 2) return list;
  }
  // 4) inline [on|off|auto] anywhere
  const inline = desc.match(/\[(on\|off\|auto)[^\]]*\]/i);
  if (inline) return ["on", "off", "auto"];
  return undefined;
}

export function cleanHelp(desc: string): string {
  let s = desc
    .replace(/\(env:\s*[^)]+\)/gi, "")
    .replace(/\(default:[^)]+\)/gi, "")
    .replace(/allowed values:[^)\n]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const dot = s.indexOf(". ");
  if (dot > 0 && dot < 180) s = s.slice(0, dot + 1);
  if (s.length > 280) s = s.slice(0, 277) + "...";
  return s;
}

// ---------- classification ----------

const REQUEST_IDS = new Set([
  "temp", "temperature", "top_k", "top_p", "min_p", "top_n_sigma", "top_n_s_sigma",
  "xtc_probability", "xtc_threshold", "typical_p", "repeat_last_n", "repeat_penalty",
  "presence_penalty", "frequency_penalty", "dry_multiplier", "dry_base", "dry_allowed_length",
  "dry_penalty_last_n", "dry_sequence_breaker", "mirostat", "mirostat_lr", "mirostat_ent",
  "samplers", "sampler_seq", "sampling_seq", "seed", "ignore_eos", "logit_bias", "grammar",
  "grammar_file", "json_schema", "json_schema_file", "n_predict", "predict", "keep",
  "cache_prompt", "cache_reuse", "cache_prompt_unused", "reasoning_effort", "reasoning_budget",
  "reasoning_budget_message", "reasoning_format", "reasoning", "reasoning_preserve",
  "chat_template_kwargs", "adaptive_target", "adaptive_decay", "dynatemp_range", "dynatemp_exp",
  "backend_sampling",
]);

const ARCHIVE_IDS = new Set([
  "mlock", "mmap", "direct_io", "defrag_thold", "draft", "draft_min", "draft_max", "draft_n",
  "spec_ngram_size_n", "spec_ngram_size_m", "spec_ngram_min_hits",
]);

export function inferScope(id: string, desc: string, section: string): ParamScope {
  const d = desc.toLowerCase();
  if (d.includes("deprecated") || d.includes("has been removed") || d.includes("the argument has been removed")) return "archive";
  if (ARCHIVE_IDS.has(id)) return "archive";
  if (section.toLowerCase().includes("sampling")) return "request";
  if (REQUEST_IDS.has(id)) return "request";
  if (id.startsWith("reasoning_")) return "request";
  if (id === "n_predict" || id.includes("cache_prompt")) return "request";
  return "server";
}

export function inferGroup(id: string, section: string, scope: ParamScope): ParamGroup {
  if (scope === "archive") return "archive";

  if (id.startsWith("reasoning") || id.startsWith("chat_template") || id === "jinja" || id === "prefill_assistant" || id === "skip_chat_parsing") return "chat";

  if (["threads", "threads_batch", "cpu_mask", "cpu_range", "cpu_strict", "cpu_strict_batch", "prio", "poll", "cpu_mask_batch", "cpu_range_batch", "prio_batch", "poll_batch", "parallel", "cont_batching", "threads_http"].includes(id)) return "speed";

  if (["cache_type_k", "cache_type_v", "cache_type_k_draft", "cache_type_v_draft", "mlock", "mmap", "direct_io", "load_mode", "kv_offload", "repack", "no_host", "numa", "fit", "fit_target", "fit_ctx", "override_tensor", "cpu_moe", "n_cpu_moe", "keep", "swa_full", "check_tensors"].includes(id)) return "memory";

  if (id.startsWith("rope") || id.startsWith("yarn") || id === "ctx_size" || id === "batch_size" || id === "ubatch_size" || id === "cache_type_k" || id === "cache_type_v" || id === "defrag_thold" || id === "swa_full" || id === "ctx_checkpoints" || id === "checkpoint_min_step" || id === "cache_ram" || id === "kv_unified" || id === "cache_idle_slots" || id === "context_shift") return "context";

  if (REQUEST_IDS.has(id) || section.toLowerCase().includes("sampling") || id.startsWith("dry_") || id.startsWith("mirostat") || id.includes("penalty") || id === "samplers") return "sampling";

  if (["model", "model_url", "docker_repo", "hf_repo", "hf_file", "hf_token", "lora", "lora_scaled", "control_vector", "control_vector_scaled", "control_vector_layer_range", "override_kv", "op_offload"].includes(id) || id.startsWith("hf_") || id.startsWith("lora") || id.startsWith("control_vector")) return "model";

  if (["device", "split_mode", "tensor_split", "main_gpu", "device_draft", "gpu_layers_draft", "list_devices"].includes(id) || id.includes("gpu_layers") || id.startsWith("split") || id.startsWith("tensor")) return "devices";

  if (id.startsWith("spec_") || id.startsWith("draft") || id.includes("ngram")) return "speculative";

  if (["host", "port", "reuse_port", "path", "cors_origins", "cors_methods", "cors_headers", "cors_credentials", "api_prefix", "ssl_key_file", "ssl_cert_file", "timeout", "sse_ping_interval", "models_dir", "models_preset", "models_max", "models_autoload", "api_key", "api_key_file", "props", "slots", "slot_save_path", "media_path", "metrics"].includes(id) || id.startsWith("cors") || id.startsWith("ssl")) return "server";

  if (["tools", "tools_runtime", "mcp_servers_config", "mcp_servers_json", "agent", "ui_mcp_proxy", "webui_mcp_proxy"].includes(id) || id.startsWith("mcp") || id.startsWith("tools") || id === "agent") return "agents";

  if (id.startsWith("mmproj") || id.startsWith("mm") || id.includes("image_") || id === "mtmd_batch_max_tokens" || id === "embd_normalize" || id === "pooling" || id === "embedding" || id === "reranking" || id.startsWith("embd_") || id.startsWith("fim_")) return "multimodal";

  if (id.startsWith("log") || id === "verbose" || id === "verbosity" || id === "offline" || id === "warmup" || id === "special") return "logging";

  const sec = section.toLowerCase();
  if (sec.includes("speculative")) return "speculative";
  if (sec.includes("common")) {
    if (id.startsWith("log") || id.startsWith("verbosity")) return "logging";
    if (id.startsWith("spec")) return "speculative";
    return "model";
  }
  if (sec.includes("example")) {
    if (id.includes("parallel") || id.includes("batch")) return "speed";
    if (id.includes("host") || id.includes("port") || id.includes("ssl") || id.includes("api")) return "server";
    if (id.includes("reasoning") || id.includes("chat")) return "chat";
    return "model";
  }
  return "model";
}

export function inferControl(id: string, desc: string, flagPart: string, allowed: string[] | undefined, defaultVal: unknown, takesValue: boolean): Control {
  const d = desc.toLowerCase();

  if (allowed && allowed.length > 0) return d.includes("comma-separated") ? "multi-enum" : "enum";
  if (d.includes("comma-separated list")) return "list";
  if (d.includes("one of:") || /\bone of\s+these\b/i.test(d)) return "enum";
  if (d.includes("path to") || d.includes("file to read") || d.endsWith(" fname") || id.endsWith("_file") || id.endsWith("_path") || id.endsWith("_dir")) return "path";

  if (typeof defaultVal === "number") {
    if (id.includes("temp") || id.includes("penalty") || id.includes("probability") || id.includes("threshold") || id.endsWith("_p") || d.includes("float")) return "float";
    return Number.isInteger(defaultVal) ? "int" : "float";
  }
  if (typeof defaultVal === "string") {
    const lv = defaultVal.toLowerCase();
    if (["true", "false", "enabled", "disabled", "on", "off"].includes(lv)) return "toggle";
    if (["auto", "none", "all", "layer", "row", "tensor"].includes(lv)) return "enum";
  }
  if (!takesValue) return "toggle";
  return "text";
}

// ---------- id/label ----------

export function toId(longFlag: string): string {
  return longFlag.replace(/^--/, "").replace(/-/g, "_") || longFlag.replace(/[^a-z0-9_]/gi, "_");
}

const LABEL_OVERRIDES: Record<string, string> = {
  n_gpu_layers: "GPU layers",
  gpu_layers: "GPU layers",
  ctx_size: "Context size",
  cache_type_k: "KV cache type K",
  cache_type_v: "KV cache type V",
  split_mode: "Split mode",
  tensor_split: "Tensor split",
  n_predict: "Tokens to predict",
  // "no_" is a llama.cpp id artifact of the --no-... alias, not the flag's
  // meaning: ON emits --reasoning-preserve, OFF is the (template) default.
  no_reasoning_preserve: "Reasoning Preserve",
};

const ACRONYMS = new Set(["gpu", "cpu", "kv", "ctx", "ngl", "api", "ssl", "jinja", "mcp", "rope", "yarn", "numa", "lora", "hf", "mmproj", "bs", "ub", "fim", "id", "url"]);

export function toLabel(id: string): string {
  if (LABEL_OVERRIDES[id]) return LABEL_OVERRIDES[id];
  return id
    .split("_")
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

// ---------- assembly ----------

// Hand corrections for params the heuristics misclassify, applied in
// buildParam after inference. "(default: template default)" trips the
// text heuristic on a plain boolean flag pair.
const CONTROL_OVERRIDES: Record<string, { control?: Control; default?: unknown; defaultLabel?: string }> = {
  no_reasoning_preserve: { control: "toggle", default: false, defaultLabel: "template default" },
};

export function buildParam(raw: RawEntry): ParamDef | undefined {
  const flags = extractFlags(raw.flags);
  if (flags.length === 0) return undefined;
  const longFlag = [...flags].reverse().find((f) => f.startsWith("--")) ?? flags.at(-1)!;
  const id = toId(longFlag);
  const env = extractEnv(raw.description);
  const def = extractDefault(raw.description);
  const allowed = extractAllowedValues(raw.description, raw.flags);
  // a flag takes a value iff there's a placeholder after the last flag token
  // ("--foo N", "--foo FNAME", "--foo <x|y>", "--foo {a,b}") or the line wrapped
  const tail = raw.flags.replace(/^.*?(?:--?[\w-]+\s*)+/, "").trim();
  const takesValue = /^[<\[]/.test(tail) || /^{\w/.test(tail) || /^[A-Z][A-Z0-9_]*$/.test(tail) || (tail.length > 0 && !/^-/.test(tail));
  const override = CONTROL_OVERRIDES[id];
  const control = override?.control ?? inferControl(id, raw.description, raw.flags, allowed, def.value, takesValue);
  const defaultValue = override && override.default !== undefined ? override.default : def.value;
  const defaultLabel = override ? override.defaultLabel ?? def.label : def.label;
  const help = cleanHelp(raw.description) || raw.description.slice(0, 120);

  const scope = inferScope(id, raw.description, raw.section);
  const group = inferGroup(id, raw.section, scope);

  const runtime: ParamDef["runtime"] = control === "list" && (id === "tensor_split" || id === "fit_target") ? "device-list" : undefined;

  const param: ParamDef = {
    id,
    label: toLabel(id),
    flags,
    ...(env ? { env } : {}),
    group,
    scope,
    control,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(defaultLabel ? { defaultLabel: defaultLabel } : {}),
    ...(allowed && allowed.length > 0 ? { options: allowed.map((v) => ({ value: v })) } : {}),
    ...(runtime ? { runtime } : {}),
    help,
    ...(scope === "archive" ? { deprecated: {} } : {}),
    ...(scope === "server" ? { requiresRestart: true } : {}),
  };
  return param;
}

// ---------- emit ----------

function emitTsFile(out: string, defs: ParamDef[]): Promise<void> {
  const header = `// Auto-generated by scripts/gen-params.ts from llama-server --help.
// Do not hand-edit defaults/flags/env/help - regenerate.
// Hand-correct labels/groups/options/scope where marked TODO.
// Source build: ${new Date().toISOString()} - ${defs.length} params
export type ParamScope = 'request' | 'server' | 'archive';
export type ParamGroup =
  | 'speed' | 'memory' | 'context' | 'sampling' | 'model' | 'devices'
  | 'speculative' | 'server' | 'agents' | 'multimodal' | 'chat' | 'logging' | 'archive';

export type ParamControl = 'int' | 'float' | 'text' | 'toggle' | 'enum' | 'multi-enum' | 'path' | 'list';

export interface ParamDef {
  id: string;
  label: string;
  flags: string[];
  env?: string;
  group: ParamGroup;
  scope: ParamScope;
  control: ParamControl;
  default?: unknown;
  defaultLabel?: string;
  min?: number; max?: number; step?: number; unit?: string;
  options?: { value: string; label?: string }[];
  runtime?: 'device-list';
  help: string;
  docUrl?: string;
  deprecated?: { since?: string; replacedBy?: string };
  requiresRestart?: boolean;
}

export const LLAMA_PARAMS: ParamDef[] = `;

  const body = JSON.stringify(defs, null, 2)
    .replace(/"([^"\\]+)":/g, "$1:");

  const footer = `

export const PARAM_BY_ID = Object.fromEntries(LLAMA_PARAMS.map((p) => [p.id, p])) as Record<string, ParamDef>;

export const PARAMS_BY_GROUP: Record<ParamGroup, ParamDef[]> = LLAMA_PARAMS.reduce(
  (acc, p) => ((acc[p.group] ||= []).push(p), acc),
  {} as Record<ParamGroup, ParamDef[]>,
);

export const GROUP_ORDER: ParamGroup[] = ${JSON.stringify(GROUP_ORDER)};
`;

  return fs.writeFile(out, header + body + footer + "\n", "utf8");
}

function emitSnapshot(out: string, defs: ParamDef[], binary: string): Promise<void> {
  const counts: Record<string, number> = {};
  const scopes: Record<string, number> = {};
  for (const d of defs) {
    counts[d.group] = (counts[d.group] ?? 0) + 1;
    scopes[d.scope] = (scopes[d.scope] ?? 0) + 1;
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines: string[] = [
    `# llama-params snapshot (${defs.length} params)`,
    ``,
    `Generated from \`${binary} --help\` on ${new Date().toISOString()}`,
    ``,
    `## By scope`,
    ...Object.entries(scopes).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## By group`,
    ...GROUP_ORDER.filter((g) => counts[g]).map((g) => `- ${g}: ${counts[g]}`),
    ``,
    `## Params`,
    `| id | label | flags | group | scope | control | default | help |`,
    `|---|---|---|---|---|---|---|---|`,
    ...defs.map((p) => `| ${p.id} | ${esc(p.label)} | ${esc(p.flags.join(", "))} | ${p.group} | ${p.scope} | ${p.control} | ${String(p.default ?? "")} | ${esc(p.help.slice(0, 60))} |`),
    ``,
  ];
  return fs.writeFile(out, lines.join("\n"), "utf8");
}

// ---------- main ----------

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const binary = arg("--binary") ?? path.resolve(process.cwd(), "llama.cpp/build/bin/llama-server");
  const out = arg("--out") ?? path.resolve(process.cwd(), "shared/llama-params.ts");

  if (args.includes("--self-check")) {
    runSelfCheck();
    return;
  }

  console.log(`[gen-params] binary: ${binary}`);
  const { stdout } = await execFileAsync(binary, ["--help"], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
  const raws = parseHelpFlags(stdout);
  console.log(`[gen-params] parsed ${raws.length} entries`);

  const seen = new Set<string>();
  const defs: ParamDef[] = [];
  for (const r of raws) {
    const p = buildParam(r);
    if (!p) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    defs.push(p);
  }
  defs.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.label.localeCompare(b.label));

  await fs.mkdir(path.dirname(out), { recursive: true });
  await emitTsFile(out, defs);
  await emitSnapshot(path.join(path.dirname(out), "llama-params.snapshot.md"), defs, binary);
  console.log(`[gen-params] wrote ${defs.length} defs to ${path.relative(process.cwd(), out)}`);

  const counts: Record<string, number> = {};
  const scopes: Record<string, number> = {};
  for (const d of defs) {
    counts[d.group] = (counts[d.group] ?? 0) + 1;
    scopes[d.scope] = (scopes[d.scope] ?? 0) + 1;
  }
  console.log("[gen-params] by group:", GROUP_ORDER.filter((g) => counts[g]).map((g) => `${g}=${counts[g]}`).join(" "));
  console.log("[gen-params] by scope:", Object.entries(scopes).map(([k, v]) => `${k}=${v}`).join(" "));
}

// ---------- self-check ----------

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`self-check failed: ${msg}`);
}

function runSelfCheck(): void {
  // extractDefault: numeric stays numeric
  assert(extractDefault("(default: -1)").value === -1, "-1 numeric");
  assert(extractDefault("(default: -1, -1 = infinity)").value === -1, "-1 dual form value");
  assert(extractDefault("(default: -1, -1 = infinity)").label === "infinity", "-1 dual form label");
  assert(extractDefault("(default: 0.05, 0.0 = disabled)").value === 0.05, "0.05 numeric");
  assert(extractDefault("(default: 0.05, 0.0 = disabled)").label === "0.0 = disabled", "0.05 label");
  assert(extractDefault("(default: 0, 0 = loaded from model)").value === 0, "0 model");
  assert(extractDefault("(default: 0, 0 = loaded from model)").label === "loaded from model", "0 model label");
  assert(extractDefault("(default: 'auto')").value === "auto", "quoted string");
  assert(extractDefault("(default: false)").value === "false", "false literal");
  assert(extractDefault("(default: same as --threads)").label === "same as --threads", "same-as label");
  assert(extractDefault("(default: 8192, -1 - no limit, 0 - disable)").value === 8192, "8192 with -1 - no limit label");
  assert(extractDefault("no default here").value === undefined, "no default");

  // extractAllowedValues: flag placeholder
  assert(JSON.stringify(extractAllowedValues("use strict CPU placement", "--cpu-strict <0|1>")) === '["0","1"]', "<0|1> placeholder");
  assert(
    extractAllowedValues("cache type\nallowed values: f32, f16, bf16, q8_0\n(default: f16)", "-ctk, --cache-type-k TYPE")?.join(",") === "f32,f16,bf16,q8_0",
    "allowed values from desc",
  );
  assert(JSON.stringify(extractAllowedValues("flash attention", "--flash-attn [on|off|auto]")) === '["on","off","auto"]', "[on|off|auto] placeholder");
  assert(JSON.stringify(extractAllowedValues("how to split the model across multiple GPUs, one of:\n- none\n- layer\n- row\n- tensor", "--split-mode {none,layer,row,tensor}")) === '["none","layer","row","tensor"]', "braces from flag");
  assert(inferControl("split_mode", "one of:\n- none\n- layer\n- row\n- tensor", "--split-mode {none,layer,row,tensor}", undefined, undefined, true) === "enum", "split_mode -> enum via one of:");

  // inferControl: enum from flag placeholder
  assert(inferControl("cpu_strict", "use strict CPU placement", "--cpu-strict <0|1>", ["0", "1"], 0, true) === "enum", "cpu_strict -> enum");
  assert(inferControl("temp", "temperature (default: 0.80)", "--temp N", undefined, 0.8, true) === "float", "temp -> float");
  assert(inferControl("seed", "RNG seed", "--seed N", undefined, -1, true) === "int", "seed -> int");
  assert(inferControl("verbose", "Set verbosity level to infinity", "--verbose", undefined, undefined, false) === "toggle", "verbose -> toggle");
  assert(inferControl("model", "model path to load", "--model FNAME", undefined, undefined, true) === "path", "model -> path");

  // CONTROL_OVERRIDES: boolean flag pair whose "(default: template default)"
  // trips the text heuristic must come out a toggle defaulting to false.
  const rp = buildParam({
    flags: "--reasoning-preserve, --no-reasoning-preserve",
    description: "preserve reasoning trace in the full history, not just the last assistant message (default: template default) (env: LLAMA_ARG_REASONING_PRESERVE)",
    section: "chat params",
    primaryFlag: "--no-reasoning-preserve",
  });
  assert(rp?.id === "no_reasoning_preserve", "rp id");
  assert(rp?.control === "toggle", "rp control toggle");
  assert(rp?.default === false, "rp default false");
  assert(rp?.defaultLabel === "template default", "rp defaultLabel");
  assert(rp?.label === "Reasoning Preserve", "rp label override");

  // toId / toLabel
  assert(toId("--cpu-strict") === "cpu_strict", "toId");
  assert(toLabel("n_gpu_layers") === "GPU layers", "label override");
  assert(toLabel("ctx_size") === "Context size", "label override 2");
  assert(toLabel("top_k") === "Top K", "toLabel normal");
  assert(toLabel("n_gpu_layers") === "GPU layers", "toLabel override");
  assert(toLabel("split_mode_kv") === "Split Mode KV", "toLabel acronyms");

  // parseHelpFlags: section detection
  const sample = `----- common params -----

-t,    --threads N                      number of CPU threads to use during generation (default: -1)
                                        (env: LLAMA_ARG_THREADS)
--cpu-strict <0|1>                      use strict CPU placement (default: 0)

----- sampling params -----

--temp, --temperature N                 temperature (default: 0.80)
`;
  const parsed = parseHelpFlags(sample);
  assert(parsed.length === 3, "parseHelpFlags count");
  assert(parsed[0].section === "common params", "section common");
  assert(parsed[0].primaryFlag === "--threads", "primary flag");
  assert(parsed[2].section === "sampling params", "section sampling");
  assert(parsed[1].description.includes("strict CPU placement"), "wrapped description merged");

  // extractFlags
  assert(JSON.stringify(extractFlags("-t,    --threads N")) === '["-t","--threads"]', "extractFlags multi");
  assert(JSON.stringify(extractFlags("-kvo, --kv-offload, -nkvo, --no-kv-offload")) === '["-kvo","--kv-offload","-nkvo","--no-kv-offload"]', "extractFlags quad");

  console.log("[gen-params] self-check ok");
}

if (import.meta.main) {
  run().catch((e) => {
    console.error("[gen-params] failed:", e);
    process.exit(1);
  });
}
