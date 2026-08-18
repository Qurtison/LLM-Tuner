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
- PENDING: mixed `-ctk q8_0 -ctv f16` and the mirror, to localize which side carries the penalty.
- Related hard constraint: **quantized KV requires flash attention** — `-fa 0` with q8_0 KV
  fails at context creation. FA is effectively mandatory.

## 5. Batch sizes: bigger is worse on a split pipeline

CUDA0/Vulkan2, Q6, q8_0 KV — pp8192 @ d0 / d32k / d98k:

| ubatch | pp results | vs default |
|---|---|---|
| 512 (default) | 962 / 619 / 353 | — |
| 1024 | 840 / 536 / 304 | **−13% everywhere** |
| 2048 | 664 / 434 / 242 | **−31%** |

Single-GPU folklore ("raise ubatch for prefill") inverts on layer-split multi-GPU:
llama.cpp pipelines ubatches across GPUs (GGML_SCHED_MAX_COPIES=4); bigger chunks mean
coarser overlap and larger per-boundary transfers (XTX is on TB4).
- PENDING: `-ub 256` (early results promising), `-b 4096` (deeper chunk pool per decode call).

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
- **Constraining ngram beats amplifying it**: rejected draft tokens waste verify compute;
  `min-hits=2` (propose only twice-seen n-grams) and `M=24` (shorter drafts) each ~+17%
  over defaults. Untested: both stacked; nmax=4.
- ngram alone ≈ no-spec on novel content; it shines on regurgitation (one compaction-style
  request hit **100% acceptance → 85.7 t/s**, ~4× the bandwidth ceiling, on a 27B).
- Acceptance % is a diagnostic, not a target — tune on gen t/s.

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
- This looks upstream-fixable (async/fused catch-up, or mem-sharing support per-arch).
  Our build is 242 commits behind master with active speculative refactors — re-measure
  after rebuild. PENDING.

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

- [ ] `-ub 256` (in flight), `-b 4096`, possible `-ub 256 -b 4096`
- [ ] Mixed KV: `-ctk q8_0 -ctv f16` vs `-ctk f16 -ctv q8_0`
- [ ] Spec stack: hits=2 + M=24 stacked; nmax=4; copy-heavy prompt sweep
- [ ] Rebuild at current master; re-measure MTP prefill tax and CUDA q8_0-KV decode
- [ ] Real-workload confirmation of f16-KV-at-reduced-context vs q8_0-at-262k
