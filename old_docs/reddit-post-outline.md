# Reddit post draft — r/LocalLLaMA

**Framing decision: the tuning journey, anchored by the knob table.** Not an eGPU post
(niche hook, and the eGPU turned out NOT to matter — that's a punchline, not a premise),
not a dry report. The story is "15 → 26+ t/s and 60k more context on the same hardware,
every knob measured, here's exactly what paid and what didn't." The two tables below are
the post; everything else is supporting material.

**Working title:** "I spent 3 days benchmarking every llama.cpp knob on my 4090
Laptop + 7900 XTX rig: +70% generation, +40% prefill, 60k more context — and half of
what I believed going in was wrong"

---

## TL;DR (open the post with this)

Same hardware, before → after: **generation 15–18 → 26–28 t/s, cold prefill ~376 →
573 t/s (22k prompt), usable context 200k → 262k.** Model: Qwen3.8-27B UD-Q6_K_XL
split across an RTX 4090 Laptop (16GB, CUDA) and a 7900 XTX (24GB, Vulkan/RADV, TB4
enclosure). Final command at the bottom.

## What each adopted knob bought (measured, not vibes)

| knob | gain | notes |
|---|---|---|
| `--spec-type draft-mtp,ngram-map-k4v` (all defaults) | **+50–70% generation** (17→26-28; copy-heavy requests spike to 85 t/s at 100% acceptance) | costs prefill (see MTP tax below) — worth it because my workload is 77% generation time |
| NVIDIA card on **CUDA** backend, AMD on Vulkan (`-dev CUDA0,Vulkan2`) | **+28% prefill** no-spec, **+41% prefill** with the spec stack (376→532) | gen identical; verdict is arch-dependent — CUDA's q8_0-KV decode collapses −50% at depth on dense models, fine on hybrid-SSM |
| `--spec-draft-device CUDA0` | **+8% prefill** (532→573) | free; found while testing a workaround for the MTP tax |
| `-fitt 256` | **+60k context** (202k→262k) | llama's fit estimator refuses launches that actually fit; this shrinks its margin |
| rebuild llama.cpp (2 weeks newer) | **+13% generation** free (25.0→28.3, identical config) | also made all my careful spec tuning obsolete (below) |
| UD-Q6_K_XL over Q8_0 | +9% gen, +3GB context, equal prefill | ONLY on CUDA — on Vulkan, Q8 prefills 12% faster (K-quant dequant is expensive in RADV, free in CUDA) |
| q8_0 KV cache | 262k context vs ~190k | costs −23% prefill/−9% gen at depth in llama-bench, but only −7.5% prefill in the real server; took the context |
| `-ts 40,60` (VRAM-proportional) | baseline | ±5 points moves ~2%; not worth tuning further |

## What I tried that did NOT help (this list cost me ~two days, take it for free)

| attempt | result |
|---|---|
| `-ub 1024` / `2048` (the classic "raise ubatch for prefill") | **−13% / −31% prefill.** Inverts on multi-GPU layer split — smaller chunks pipeline better across cards |
| `-b 4096` | +9% in llama-bench, **exactly 0% in the real server.** Bench your production path before adopting anything |
| ngram tuning (min-hits, draft length M, p-min) | won +17% on the old build; after rebuilding, ALL deltas collapsed into noise — upstream refactors absorbed what the knobs were buying. Run defaults |
| `ngram-mod` (adaptive ngram) | −17% generation |
| a trained DSpark draft head for my exact model | 1–5% acceptance (GGUF mislabeled dflash), 33% forced as dspark — still 3× slower than MTP+ngram. Trained drafters aren't plug-and-play yet |
| `-sm row` | structurally impossible: Vulkan backend has no split-buffer support at all, CUDA's needs 2+ CUDA cards |
| mixed KV types (`-ctk q8_0 -ctv f16` or mirror) | **4–13× prefill collapse** — silent kernel fallback; KV types must match |
| `-fa 0` | can't even launch: quantized KV requires flash attention |
| raising the 80W power cap | firmware says no (laptop); also irrelevant — gen is bandwidth-bound and prefill was kernel-bound |
| all-Vulkan pairing (revisited after the MTP findings) | 376 vs 532 prefill with the spec stack; gen equal — CUDA pairing survived four separate challenges |

## The traps (each one silent, each one an hour)

- llama-bench `-dev A,B` benchmarks each device SEPARATELY; `A/B` is the split. My
  first "pair" results were solos wearing pair labels.
- Repeated flags in llama-bench build a test MATRIX (two `-fa`s = both configs run).
- `-fa 0` + quantized KV fails at context creation with an unhelpful error.
- The fit estimator adds the spec/MTP context to its safety margin — spec-enabled
  launches get refused earliest.
- A GGUF finetune conversion can silently drop the MTP head (mine did — block_count
  40 vs the base's 41).
- HF cache revisions coexist: `hf download` of an updated repo does NOT update your
  pinned paths; I "benchmarked the new model" twice before noticing my profile still
  pointed at the old snapshot.

## The MTP detective story (condensed — this is the fun section, keep it)

Noticed prefill halved with `draft-mtp` on. Chased it through four theories, each
killed by the next measurement: my eGPU (no — measured), the prompt being processed
twice (real but too small), CUDA graph re-capture (artifact of a mislabeled run), and
finally the truth: **the per-ubatch draft catch-up decode breaks multi-GPU ubatch
pipelining** — single GPU pays 1.03–1.22×, ANY layer split pays 1.8–2.0×, either
backend. Filed upstream: [ISSUE LINK]. Along the way my acceptance numbers
independently corroborated #26750 (MTP acceptance collapses on CUDA: 41% vs 64% on
Vulkan, same file) — so there are two pending upstream fixes that would give this rig
another ~2× prefill and +20% gen without touching a flag.

## Method notes (why I trust these numbers)

- llama-bench for hardware questions, real llama-server A/Bs (fixed 22k-token prompt,
  fixed gen length, 2 reps) for anything involving speculation — llama-bench can't
  measure spec at all.
- Bench wins were CONFIRMED against the server before adoption after `-b 4096`
  taught me they don't transfer (0 of 1 transferred fully; f16-KV transferred at
  ~1/3 strength).
- Every number in this post came from a run I can re-execute in ~10 minutes.
  [Optionally: link BENCH-FINDINGS.md as a gist for the full tables.]

## Final config

```
llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf -c 262144 -ngl 999 -fa on \
  -ctk q8_0 -ctv q8_0 --spec-type draft-mtp,ngram-map-k4v --spec-draft-n-max 3 \
  --spec-draft-device CUDA0 --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60 \
  --jinja -fitt 256
```

## Before posting

- [ ] Insert the upstream issue URL (two places)
- [ ] Decide whether to gist BENCH-FINDINGS.md and link it
- [ ] Rewrite in your own voice (same rule as the issue — the tables can stay)
- [ ] Screenshot candidates: the isolation matrix, a Monitor session graph
