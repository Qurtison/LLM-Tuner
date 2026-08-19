# Multi-GPU llama.cpp Benchmark Findings — RTX 4090 Laptop + RX 7900 XTX

Running log of measured conclusions from systematic benchmarking, 2026-08-17/18.
Kept current as tests complete; drafted for eventual write-up/Reddit post.

## Rig

- **GPU A**: RTX 4090 Laptop, 16GB, ~576 GB/s, internal, 80W firmware power cap (Dynamic Boost caps ~95W on Linux)
- **GPU B**: RX 7900 XTX, 24GB, ~960 GB/s, desktop card in a **Thunderbolt 4 eGPU enclosure** (RADV)
- llama.cpp commit `6c8dcaa7a` (2026-08-03), two builds: Vulkan-only and CUDA+Vulkan
- Primary model: Qwen3.8-27B (qwen35 arch: **hybrid SSM + attention, only 16 of 65 layers have KV attention**, head_dim 256, +1 MTP nextn layer), UD-Q6_K_XL (24.13 GiB)
- Probe model for solo-card tests: qwen2.5-coder-7b Q4_K_M (4.36 GiB, dense attention)
- Standard test: `-fa 1 -ctk q8_0 -ctv q8_0 -p 8192 -n 128 -d 0,32768,98304`

## 1. CUDA vs Vulkan on the same NVIDIA card (7B solo)

| test | Vulkan1 | CUDA0 | delta |
|---|---|---|---|
| pp8192 @ d0 | 2180 | 3541 | **+62%** |
| pp8192 @ d32k | 754 | 1437 | **+91%** |
| pp8192 @ d98k | 335 | 556 | **+66%** |
| tg128 @ d0 | 71.1 | 73.6 | +3% |
| tg128 @ d32k | 55.7 | 39.7 | **−29%** |
| tg128 @ d98k | 39.7 | 20.4 | **−49%** |

- CUDA prefill is massively faster (tensor cores + mature kernels). The Vulkan gap exists partly because the driver exposes `VK_NV_cooperative_matrix2` but not all feature bits ggml requires, so Vulkan FA runs the slower KHR_coopmat path.
- **CUDA FA *decode* with q8_0 KV collapses at depth on dense-attention models** (half of Vulkan's speed on the identical card at 98k). This penalty is architecture-dependent — see §2.
- Generation ≈ equal at depth 0: bandwidth-bound, backend barely matters.

## 2. Pairing verdict (27B, ts 40/60): CUDA0/Vulkan2 wins — zero tradeoff

UD-Q6_K_XL, matched ts 40/60:

| test | Vulkan1/Vulkan2 | CUDA0/Vulkan2 | delta |
|---|---|---|---|
| pp8192 @ d0 | 754 | 962 | **+28%** |
| pp8192 @ d32k | 507 | 619 | **+22%** |
| pp8192 @ d98k | 295 | 353 | **+20%** |
| tg128 @ d0 | 18.46 | 18.61 | +1% |
| tg128 @ d32k | 17.07 | 17.00 | 0% |
| tg128 @ d98k | 14.26 | 14.26 | identical |

The 7B's CUDA decode collapse (§1) does **not** transfer: the hybrid arch has only 16/65
attention layers, diluting the quantized-KV FA penalty to nothing. **Verdict is
architecture-dependent**: hybrid-SSM models → CUDA pairing; dense long-context models →
re-test before switching.

Q8_0 quant, ts 40/60 vs 39/61 (~1% skew, verdict unchanged): pp +14/+15/+24%, tg −4/−2/+5%.

## 3. Quant speed: Q6_K's prefill penalty is Vulkan-only

- Vulkan pair: Q6_K_XL prefills **11% slower** than Q8_0 (754 vs 847 @ d0) — K-quant
  super-block dequant is expensive in RADV kernels; Q8_0's flat 8-bit layout is fast.
- CUDA pair: Q6 = Q8 prefill exactly (962 vs 965; 353 vs 355 @ d98k). CUDA dequants Q6_K free.
- Q6 gens ~9% faster than Q8 (fewer bytes/token) with ~3GB more VRAM headroom.
- **With the CUDA pairing, Q6_K_XL strictly dominates Q8_0 on speed.** Q8 remains a
  quality choice, paid in ~3GB context headroom, not speed.

## 4. KV cache quantization costs real speed at depth (even on hybrid arch)

CUDA0/Vulkan2, Q6, f16 KV vs q8_0 KV:

| test | q8_0 KV | f16 KV | delta |
|---|---|---|---|
| pp8192 @ d0 | 962 | 984 | +2% |
| pp8192 @ d32k | 619 | 711 | **+15%** |
| pp8192 @ d98k | 353 | 435 | **+23%** |
| tg128 @ d98k | 14.26 | 15.48 | **+8.6%** |

- Cost: f16 KV ≈ 66KB/token vs q8_0's ≈ 34KB (this arch) → 262k context becomes ~180–200k max.
- **Mixed KV types are a kernel-fallback pit**: `-ctk q8_0 -ctv f16` prefilled at
  **71 t/s** (13× collapse vs 962; gen unaffected at 17.9) — the FA prefill path
  evidently requires uniform KV types and silently falls back otherwise. Mirror
  (`-ctk f16 -ctv q8_0`): also a dud (209 t/s pp2048, ~4× below par). **The KV choice
  is strictly binary: q8_0-both at 262k vs f16-both at ~190k max.** Production
  confirmation of the f16 win: PENDING (srv-f16kv sweep row).
- Related hard constraint: **quantized KV requires flash attention** — `-fa 0` with q8_0 KV
  fails at context creation. FA is effectively mandatory.

## 5. Batch sizes: bigger is worse on a split pipeline

CUDA0/Vulkan2, Q6, q8_0 KV — pp8192 @ d0 / d32k / d98k:

| config | pp8192 d0 / d32k / d98k | vs default |
|---|---|---|
| ub 512, b 2048 (defaults) | 962 / 619 / 353 | — |
| ub 1024 | 840 / 536 / 304 | −13% everywhere |
| ub 2048 | 664 / 434 / 242 | −31% |
| **ub 256** | 993 / 638 / 372 | +3–5% |
| **b 4096** (ub default) | **1052 / 675 / 381** | **+8–9%** |
| ub 256 + b 4096 | 1026 / 666 / **389** | +7–10% |

Generation is unchanged in every case (~18.6 / 17.0 / 14.1 t/s — batch knobs are
prefill-only levers here).

Single-GPU folklore ("raise ubatch for prefill") inverts on layer-split multi-GPU:
llama.cpp pipelines ubatches across GPUs (GGML_SCHED_MAX_COPIES=4). Bigger chunks =
coarser overlap and larger per-boundary transfers (XTX is on TB4) → ub 1024/2048 lose
badly. Going the other way helps: smaller chunks (ub 256) +3–5%, and a deeper chunk pool
per decode call (**b 4096: +8–9%, the single best free win**) lets the scheduler keep the
pipeline full. The stack (ub 256 + b 4096) only edges ahead at 98k depth (+2%, near
noise).
- **Transfer caveat: the `-b 4096` gain did NOT reproduce in real llama-server prefill**
  (22k cold prompt: 522 vs 532 t/s with the spec stack; 965 vs 973 without — no change).
  llama-bench's pp path and the server's prompt-processing path evidently schedule
  differently. Harmless to keep the flag, but it is not the free +9% in production that
  the bench suggested. Investigate someday.
- PENDING: `-b 4096` stacked with f16 KV in llama-bench (and whether f16 KV's win
  transfers to the server, given the -b lesson).

## 6. Row split (`-sm row`) is unavailable on this rig — by construction

`llama-model.cpp` resolves row split via the backend's `ggml_backend_split_buffer_type`
proc. **The Vulkan backend does not implement it at all** ("device does not support split
buffers"), and CUDA's implementation splits across multiple CUDA devices only (we have
one). Mixed CUDA+Vulkan row split is doubly impossible. Layer split (taking turns) is the
only multi-GPU mode for this hardware; per-token GPU utilization (~45%/65%) matching each
card's layer share confirms the serial pipeline runs with no dead air.

## 7. Speculative decoding stack (llama-server; llama-bench can't measure this)

Real-workload A/B (code-review prompt, 22k cold prefill + 1024 gen tokens, CUDA pairing):

| config | gen t/s | draft acc |
|---|---|---|
| draft-mtp + ngram-map-k4v (defaults: M=48, hits=1), nmax=3 | 25.0 | 40% |
| draft-mtp only | 24.6 | 39% |
| ngram-map-k4v only | **17.1** | 4–14% |
| mtp + k4v, **min-hits=2** | **29.2** | 53% |
| mtp + k4v, M=96 | 25.4 | 36% |
| mtp + k4v, **M=24** | **29.6** | 50% |

- No-spec baseline ≈ 17–18 t/s → the tuned stack is **~+70% generation**.
- **Constraining ngram beats amplifying it** (old build): rejected draft tokens waste
  verify compute; `min-hits=2` and `M=24` (shorter drafts) each ~+17% over defaults.
- **Rebuild caveat (master `6d0549831`)**: re-running the same sweep, defaults improved to
  28.3 t/s (+13% from the rebuild alone) and the tuning deltas compressed into
  run-to-run noise (defaults 28.3, hits=2 25.9, M=24 27.1 — single reps at temp 1).
  The upstream spec refactors appear to have absorbed much of what the constraint
  tuning was buying. Defaults are fine on current master; re-tune only with multi-rep
  runs if chasing the last few percent.
- ngram alone ≈ no-spec on novel content; it shines on regurgitation (one compaction-style
  request hit **100% acceptance → 85.7 t/s**, ~4× the bandwidth ceiling, on a 27B).
- Acceptance % is a diagnostic, not a target — tune on gen t/s.
- **Post-rebuild knob sweep (2026-08-19): nothing beats defaults.** ngram-mod is
  clearly worse (21.0 vs 25.2 gen — adaptive resetting turns conservative: high
  acceptance, few drafts); `--spec-draft-p-min` 0.5 and 0.9 are both a wash vs the
  ~0.75 default. Combined with the tuning deltas evaporating after the rebuild, the
  ngram/MTP search space is exhausted: **run defaults**.
- **Trained-drafter attempt (DSpark head for this target, magnitudedev GGUF
  conversion, arch `dflash`): failed hard** — 1–5% draft acceptance, generation
  collapsed to ~4 t/s (drafting + cross-device overhead with zero accepted tokens),
  prefill ~470. Near-zero acceptance means the head's outputs don't match this
  target (bad conversion, wrong revision, or dflash/dspark pipeline mismatch), not
  an overhead problem.
- Retry with `--spec-type draft-dspark` (overriding the GGUF's dflash tag): runs, and
  acceptance jumps 1–5% → 33% — confirming the pipeline mismatch — but 33% can't pay
  for cross-device drafting overhead: 7.9 t/s. Head judged mediocre for this target;
  dropped after two strikes. **Champion stands: `draft-mtp,ngram-map-k4v`, defaults.**

## 8. MTP's hidden prefill tax (~1.9×) — mechanism found

- Measured: prefill ~520 t/s with draft-mtp enabled vs ~975 without (matches no-spec).
- Mechanism (`common/speculative.cpp`, MTP `process()` hook): unless the model's MTP
  context **shares KV memory with the target** ("e.g. Gemma4"), every prefill ubatch
  triggers a synchronous **catch-up decode in the draft context** — the prompt is
  effectively processed twice, and the extra sync breaks the multi-GPU ubatch pipeline.
  Qwen3.8's MTP context is not mem-shared → full tax.
- Net accounting on 4 days of real usage (139 requests): prefill 1.45h vs generation
  4.94h (**3.4:1 gen-dominated**). Dropping MTP would refund ~40min of prefill but cost
  48–96min of gen. **Keeping MTP wins decisively** despite the tax.
- **Re-measured after rebuilding at master `6d0549831` (2026-08-18): the tax is
  unchanged** — prefill 532/522 t/s with MTP vs 973/965 without (~1.85×).
- **Single-GPU isolation (2026-08-19)**: Qwen3.6-35B-A3B (same arch family,
  nextn=1) solo on the XTX, 22k cold prompt: 1307 t/s with MTP vs 1593 without =
  **1.22×**. So the raw catch-up decode costs ~20%; the remaining ~50 points of the
  multi-GPU tax come from the synchronous per-ubatch draft decode **stalling the
  layer-split ubatch pipeline**. The dominant cost is the sync, not the compute —
  which makes async/overlapped catch-up the high-payoff upstream fix.
- Isolation bonus: on the A3B, MTP is +61% generation (83.9 vs 52.1 t/s, 66%
  acceptance) — the 35B-A3B solo on the XTX is a legitimately fast light-duty
  config (~84 t/s gen, ~1300-1600 t/s prefill).

## 9. Tensor split sensitivity: low

45/55 vs 40/60 (CUDA pair, Q6): prefill +5–7% (more layers on the prefill-fast CUDA card),
gen −1.5–2% (more bytes on the slower-bandwidth card). Weighted by the 3.4:1 gen-dominated
workload it's a wash; 40/60 also preserves VRAM headroom on the 16GB card. Splits within
±5 points of VRAM-proportional are all fine.

## 10. Miscellaneous measured facts

- TB4 to the eGPU is negligible for solo and layer-split use (weights/KV/activations stay
  on-card; per-token boundary traffic is KBs).
- Bandwidth efficiency: XTX solo gen achieves ~41% of its 960 GB/s; the 4090 ~54% of its
  576 GB/s. The XTX has the pipes, RADV wastes more of them; the smaller card runs cleaner.
- The 4090's 80W cap only became binding once CUDA kernels could saturate it (Vulkan-era
  ~50W draw was kernel starvation, not power headroom).
- llama-bench gotchas: device pairs use `/` (`CUDA0/Vulkan2`); a comma benches each device
  separately. Repeated flags (e.g. two `-fa`) build a test matrix, not an override.
- llama-server's `-fit` pre-check estimates against free VRAM + margins (default 1GiB/dev
  + the spec/MTP context reservation) and refuses launches that would actually fit;
  `-fitt 256` reclaimed 262k context that the default margin refused.

## Open items

- [x] `-ub 256` / `-b 4096` / stacked — measured in llama-bench; server transfer FAILED (§5)
- [ ] `-b 4096` + f16 KV stacked
- [ ] Mixed KV: `-ctk q8_0 -ctv f16` vs `-ctk f16 -ctv q8_0`
- [x] Spec knob sweep post-rebuild — defaults win everywhere (§7)
- [x] DSpark head — dspark mode confirmed correct pipeline (33% acc) but still 3× slower
      than champion; dropped (§7)
- [x] Rebuilt at `6d0549831` — MTP tax unchanged (§8); spec gen +13%, tuning deltas now noise (§7)
- [ ] File upstream issue: MTP catch-up decode ~2× prefill cost on non-mem-shared archs
- [ ] Real-workload confirmation of f16-KV-at-reduced-context vs q8_0-at-262k
