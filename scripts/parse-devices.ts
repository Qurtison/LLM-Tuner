#!/usr/bin/env bun
/**
 * Parse `llama-server --list-devices` output into an ordered device list.
 *
 * Output format (from llama.cpp/common/arg.cpp `common_print_available_devices`):
 *
 *     Available devices:
 *       CUDA0: Tesla V100 (16160 MiB, 15999 MiB free)
 *       Metal1: Apple M1 Max (32768 MiB, 30000 MiB free)
 *       (none)            <- no devices
 *
 * The order in the source output is the order the UI must use: tensor_split
 * fractions map positionally to that order.
 *
 * Usage:
 *   bun scripts/parse-devices.ts [--binary path]      # prints JSON
 *   bun scripts/parse-devices.ts --self-check         # runs assertions
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface Device {
  name: string;        // "CUDA0"
  description: string; // "Tesla V100"
  totalMiB: number;
  freeMiB: number;
}

const DEVICE_LINE = /^\s*([A-Za-z][\w.-]*)\s*:\s*([^()]+?)\s*\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB\s*free)?\)/;

export function parseDeviceList(stdout: string): Device[] {
  const out: Device[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(DEVICE_LINE);
    if (!m) continue;
    out.push({
      name: m[1],
      description: m[2].trim(),
      totalMiB: Number(m[3]),
      freeMiB: m[4] ? Number(m[4]) : 0,
    });
  }
  return out;
}

// Tensor split: an array of per-device fractions in [0, 1], same length as
// devices, that gets normalized to integers for `--tensor-split`. The UI uses
// the device's slot value directly and we compute the integer form on save.
export function fractionsToTensorSplit(fractions: number[]): string {
  const sum = fractions.reduce((a, b) => a + b, 0);
  if (sum <= 0) return fractions.map(() => 0).join(",");
  // 1000 parts is enough resolution; matches llama.cpp's existing examples (3,1)
  const parts = fractions.map((f) => Math.max(0, Math.round((f / sum) * 1000)));
  // fix rounding drift so it sums to 1000
  const drift = 1000 - parts.reduce((a, b) => a + b, 0);
  if (drift !== 0 && parts.length > 0) {
    const i = parts.indexOf(Math.max(...parts));
    parts[i] += drift;
  }
  return parts.join(",");
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const binary = getArg("--binary") ?? path.resolve(process.cwd(), "llama.cpp/build/bin/llama-server");

  if (args.includes("--self-check")) {
    runSelfCheck();
    return;
  }

  const { stdout } = await execFileAsync(binary, ["--list-devices"], { timeout: 8000, maxBuffer: 64 * 1024 });
  const devices = parseDeviceList(stdout);
  console.log(JSON.stringify(devices, null, 2));
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`self-check failed: ${msg}`);
}

function runSelfCheck(): void {
  const sample = `Available devices:
  CUDA0: Tesla V100 (16160 MiB, 15999 MiB free)
  Metal1: Apple M1 Max (32768 MiB, 30000 MiB free)
`;
  const d = parseDeviceList(sample);
  assert(d.length === 2, "two devices");
  assert(d[0].name === "CUDA0" && d[0].totalMiB === 16160 && d[0].freeMiB === 15999, "cuda0 fields");
  assert(d[1].name === "Metal1" && d[1].totalMiB === 32768, "metal1 fields");

  const empty = parseDeviceList("Available devices:\n  (none)\n");
  assert(empty.length === 0, "none produces empty");

  // fractions → tensor split
  assert(fractionsToTensorSplit([1, 1]) === "500,500", "50/50");
  assert(fractionsToTensorSplit([0, 1]) === "0,1000", "0/100 pushes to second");
  assert(fractionsToTensorSplit([1, 0, 0]) === "1000,0,0", "all on first");
  assert(fractionsToTensorSplit([2, 3]) === "400,600", "40/60 normalized");
  assert(fractionsToTensorSplit([0, 0, 0]) === "0,0,0", "all zero stays zero");

  // order matters: 2 GPUs, slider at 100% on index 0 → 1000,0
  assert(fractionsToTensorSplit([1, 0]) === "1000,0", "order respected");

  console.log("[parse-devices] self-check ok");
}

if (import.meta.main) {
  run().catch((e) => {
    console.error("[parse-devices] failed:", e);
    process.exit(1);
  });
}
