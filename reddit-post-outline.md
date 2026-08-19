# Reddit post outline — r/LocalLLaMA

**Working title:** "I benchmarked everything on a weird rig (4090 Laptop + 7900 XTX eGPU,
llama.cpp): CUDA+Vulkan mixed pairing, MTP's hidden prefill tax, KV quant costs, and
several things that turned out to be folklore"

All numbers: Qwen3.8-27B UD-Q6_K_XL, `-fa 1`, q8_0 KV unless noted, `-p 8192 -n 128
-d 0,32768,98304`. Full tables in BENCH-FINDINGS.md — quote from there.

## Hook (1 paragraph)
Odd rig: 16GB laptop 4090 (80W cap) + 24GB 7900 XTX in a TB4 enclosure. Spent two days
benchmarking every knob with llama-bench AND real llama-server workloads. Half the
common wisdom inverted; several silent traps found. Numbers inside.

## 1. Mixed-backend pairing works and wins — run your NVIDIA card on CUDA even next to a Vulkan AMD card
- Same physical 4090: CUDA prefill +62–91% over Vulkan (7B solo table).
- Pair verdict (27B): CUDA0+Vulkan2 beats all-Vulkan +20–28% prefill, gen identical.
- Trap: verdict is architecture-dependent — CUDA FA *decode* with q8_0 KV collapses
  −50% at depth on dense models but is fine on hybrid-SSM (16/65 attn layers).
- Quote tables: §1, §2.

## 2. MTP has a hidden ~2× prefill tax (and it's mostly a pipeline stall)
- prefill 532 t/s with draft-mtp vs 973 without, two builds two weeks apart.
- Single-GPU isolation: only 1.22× solo → the multi-GPU cost is the synchronous
  per-ubatch catch-up decode stalling layer-split pipelining.
- Mechanism found in common/speculative.cpp (is_mem_shared skip). Filed upstream: [link].
- Net math on 4 days of real usage (gen-dominated 3.4:1): keeping MTP still wins.
  Quote: §8.

## 3. Speculative stack real-workload results (llama-bench can't measure this)
- Tuned mtp+ngram stack ≈ +70% gen over no-spec; one copy-heavy request hit 100%
  acceptance → 85.7 t/s on a 27B (~4× the bandwidth ceiling).
- Tuning knobs (min-hits, draft length, p-min, ngram-mod) all collapsed to noise after
  a rebuild — upstream refactors absorbed the wins. Run defaults.
- Trained DSpark head for this exact model: GGUF conversion mislabeled dflash (1–5%
  acceptance); forced dspark mode → 33% acceptance, still 3× slower than MTP+ngram.
  Trained drafters are not plug-and-play yet.
- Quote: §7.

## 4. Batch-size folklore inverts on multi-GPU layer split
- ub 1024/2048: −13%/−31% prefill. ub 256: +3–5%. b 4096: +9% in llama-bench…
- …and then the +9% did NOT transfer to llama-server. Bench your production path.
- Quote: §5.

## 5. Silent traps (each cost an hour; here's the list)
- Mixed KV types (`-ctk q8_0 -ctv f16` or mirror) = 4–13× prefill fallback pit.
- Quantized KV requires FA — `-fa 0` + q8_0 KV won't even create a context.
- `-sm row`: Vulkan backend has no split-buffer support at all; CUDA needs 2+ CUDA cards.
- llama-bench `-dev A,B` benches devices SEPARATELY; `A/B` is the split. Repeated flags
  build a test matrix, not an override.
- llama-server's -fit estimator refuses launches that actually fit (margins + spec
  reservation); `-fitt 256` reclaimed 60k context.
- Q6_K prefills 11% slower than Q8_0 — but only on Vulkan; CUDA dequants it free.
- Quote: §3, §4, §6, §10.

## 6. KV precision decision (the one real tradeoff left)
- f16 KV: +15–23% prefill, +9% gen at depth (bench). Cost: 34→66KB/token → 262k ctx
  becomes ~190k. [Insert srv-f16kv production number when run.]
- Quote: §4.

## Closing
- Config I landed on (paste it), net gains vs where I started (prefill ~2×* with spec
  off / gen +70% with spec on), link to full findings doc + upstream issue.
- Offer: happy to run requests on this rig.

*sanity-check exact end-to-end multipliers against BENCH-FINDINGS before posting.
