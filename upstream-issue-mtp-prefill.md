# Draft GitHub issue for ggml-org/llama.cpp — review before posting

---

**Title:** `Eval bug: draft-mtp costs ~1.8x prompt processing on CUDA (vs ~1.15x on Vulkan) — per-ubatch catch-up decode halves graph reuse`

---

## Summary

Enabling `--spec-type draft-mtp` on a model whose MTP context is not mem-shared makes
prompt processing **~1.8× slower on the CUDA backend**, but only **~1.15× slower on
Vulkan** — same model file, same flags, same machine. The MTP `process()` hook runs a
synchronous catch-up decode in the draft context for every prefill ubatch; the
`graphs reused` counter shows this interleaving **halves graph reuse on both
backends**, but only CUDA pays a large time cost for the lost reuse (re-capture /
rebuild being far more expensive there than Vulkan's dispatch path).

For long-context workloads (agents, large-document ingestion, cache-cold re-prefills)
this roughly doubles every cold prefill on CUDA and CUDA-containing multi-GPU splits.

## Environment

- llama.cpp `6d0549831` (identical behavior on `6c8dcaa7a`, 2026-08-03 — not a recent
  regression)
- Linux, CUDA 12.0 + Vulkan build
- GPUs: RTX 4090 Laptop (internal PCIe; CUDA0 / Vulkan1), RX 7900 XTX (RADV; Vulkan2)
- Models: Qwen3.8-27B (`qwen35`, hybrid SSM+attention, `nextn_predict_layers=1`) at
  UD-Q6_K_XL and UD-Q3_K_XL; Qwen3.6-35B-A3B (`qwen35moe`, nextn=1) Q4_K_M
- `-fa on`, `-ctk q8_0 -ctv q8_0`

## Reproduction

Launch llama-server twice, identical except `--spec-type draft-mtp` vs
`--spec-type ngram-map-k4v` (ngram leaves prefill untouched — it matches the no-spec
prefill rate), send the same ~22k-token cold prompt, compare
`prompt eval time ... tokens per second`:

```
llama-server -m Qwen3.8-27B-UD-Q3_K_XL.gguf -c 32768 -ngl 999 -fa on \
  -ctk q8_0 -ctv q8_0 --spec-type draft-mtp --spec-draft-n-max 3 -dev CUDA0 --jinja
# vs --spec-type ngram-map-k4v
```

## Measurements — isolation matrix

22k-token cold prompt, prompt-eval t/s, no-MTP vs MTP (same file per row):

| config | backend | no MTP | with MTP | tax |
|---|---|---|---|---|
| 27B UD-Q3_K_XL, 4090 solo | **CUDA** | 1007 | 555 | **1.82×** |
| 27B UD-Q3_K_XL, 7900 XTX solo | Vulkan | 572 | 505 | **1.13×** |
| 35B-A3B Q4_K_M, 7900 XTX solo | Vulkan | 1593 | 1307 | 1.22× |
| 27B UD-Q6_K_XL, CUDA0+Vulkan2 layer split | CUDA+Vulkan | 973 | 532 | 1.83× |

Same model, same flags, two backends: **1.82× on CUDA vs 1.13× on Vulkan** — the cost
is backend-specific, not (as I first assumed) a multi-GPU pipeline effect; the split
setup inherits CUDA's tax.

**`graphs reused` (print_timings) for the Q3 pairs — MTP halves reuse on both
backends:**

| run | graphs reused (rep1 / rep2) |
|---|---|
| CUDA solo, ngram | 960 / 1847 |
| CUDA solo, draft-mtp | 425 / 837 |
| Vulkan solo, ngram | 897 / 1841 |
| Vulkan solo, draft-mtp | 346 / 773 |

Generation-side MTP behavior is good (+40–60% gen in these runs); this issue is only
about the prompt-processing cost.

## Where the cost seems to come from

`common/speculative.cpp`, MTP `process(batch_in)` hook, runs per prefill ubatch:

```cpp
// if kv is shared with target (e.g Gemma4), then we can skip this catch-up decode
if (!is_mem_shared) {
    common_batch_clear(batch);
    ...
```

Alternating target-ctx and draft-ctx decodes every ubatch defeats graph reuse (see
table above). Vulkan tolerates the rebuilds; CUDA's graph re-capture cost appears to
account for most of the 1.8×. The target also emits embeddings for every prompt
position (`llama_set_embeddings_nextn`), which presumably adds some memory traffic on
top.

## Possible directions (outsider's read)

- Keep separate cached graphs per context so target/draft interleaving doesn't
  invalidate reuse (the counter suggests reuse mechanically halves, i.e. the two
  contexts are contending rather than each reusing its own).
- Batch/defer the catch-up decodes (e.g. run the draft catch-up once per N ubatches or
  asynchronously) instead of strictly interleaving.
- Extend the `is_mem_shared` fast path to more architectures where layout allows.

Happy to run patches or provide more measurements — every row above is reproducible on
demand (models are public on HF).
