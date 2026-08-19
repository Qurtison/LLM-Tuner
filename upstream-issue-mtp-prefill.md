# Draft GitHub issue for ggml-org/llama.cpp — review before posting

---

**Title:** `speculative : draft-mtp roughly halves prompt processing speed (catch-up decode re-processes the whole prompt when MTP context is not mem-shared)`

**Labels suggestion:** performance, speculative

---

## Summary

Enabling `--spec-type draft-mtp` on a model whose MTP context does not share KV memory
with the target cuts **prompt processing throughput roughly in half** (~1.85× slower in
my measurements). The cost appears to come from the MTP `process()` hook running a
synchronous catch-up decode in the draft context for **every prefill ubatch**, so the
prompt is effectively processed twice — and on multi-GPU layer split, the per-ubatch
synchronization also defeats ubatch pipelining.

For long-context workloads (agents, large-document ingestion, cache-cold re-prefills
after restarts) this tax is large enough to eat a substantial fraction of MTP's decode
benefit: on my usage profile, MTP's ~+45% generation gain arrives alongside a ~2×
slowdown of every cold prefill.

## Environment

- llama.cpp `6d0549831` (also reproduced identically on `6c8dcaa7a`, 2026-08-03 — so
  this is not a recent regression; both builds behave the same)
- Linux, CUDA 12.0 + Vulkan build
- Devices: RTX 4090 Laptop (CUDA0) + RX 7900 XTX (Vulkan/RADV), `--split-mode layer`,
  `-ts 40/60`
- Model: Qwen3.8-27B (arch `qwen35`, hybrid SSM + attention, `nextn_predict_layers = 1`),
  UD-Q6_K_XL quant
- `-fa on`, `-ctk q8_0 -ctv q8_0`

## Reproduction

Launch llama-server twice, identical except for `--spec-type`, and send the same
~22k-token prompt (cache-cold) to each:

```
# A: MTP enabled
llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf -c 262144 -ngl 999 -fa on \
  -ctk q8_0 -ctv q8_0 --spec-type draft-mtp --spec-draft-n-max 3 \
  -dev CUDA0,Vulkan2 -ts 40/60 --jinja

# B: no MTP (ngram-only or no spec — both give the same prefill numbers)
llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf -c 262144 -ngl 999 -fa on \
  -ctk q8_0 -ctv q8_0 --spec-type ngram-map-k4v \
  -dev CUDA0,Vulkan2 -ts 40/60 --jinja
```

Compare `prompt eval time ... tokens per second` in the per-request timings.

## Measurements

22,284-token cold prompt, prompt-eval t/s from server timings, several runs each:

| config | prompt t/s |
|---|---|
| `--spec-type draft-mtp,ngram-map-k4v` | 532 / 522 |
| `--spec-type draft-mtp` | 527 |
| `--spec-type ngram-map-k4v` (no MTP) | 973 / 965 |
| no spec at all (llama-bench pp, same split) | ~962 |

MTP consistently costs ~1.85× on prompt processing. Generation-side MTP behavior is
fine (that's the point of it); this issue is only about the prefill cost.

**Single-GPU isolation** (Qwen3.6-35B-A3B, `qwen35moe`, nextn=1, solo on the 7900 XTX,
same 22k cold prompt):

| config | prompt t/s |
|---|---|
| `--spec-type draft-mtp` | 1307 |
| `--spec-type ngram-map-k4v` (no MTP) | 1593 |

i.e. **~1.22× single-GPU vs ~1.85× on the two-GPU layer split**. The raw catch-up
decode accounts for ~20%; the larger multi-GPU cost appears to be the synchronous
per-ubatch draft decode **stalling the layer-split ubatch pipeline**.

## Where the cost seems to come from

In `common/speculative.cpp`, the MTP implementation's `process(batch_in)` hook (called
per prefill ubatch) does:

```cpp
// if kv is shared with target (e.g Gemma4), then we can skip this catch-up decode
if (!is_mem_shared) {
    common_batch_clear(batch);
    ...
```

i.e. for every prompt ubatch, a catch-up decode runs in the draft context. For a model
whose MTP context is not mem-shared (as here), that means the entire prompt is decoded a
second time. A single extra nextn layer should cost a few percent, not ~90% — I suspect
the synchronous per-ubatch draft decode also stalls the multi-GPU ubatch pipeline
(GGML_SCHED_MAX_COPIES overlap), which would explain the size of the hit on split
setups. The single-GPU isolation above separates the two components: ~1.22× from the extra decode itself, the rest from the pipeline stall.

There is also the related requirement that the target emit embeddings/logits for every
prompt position (`llama_set_embeddings_nextn`, and the `begin()` warning about
"process() hook may not have run on every prefill ubatch"), which presumably adds
memory traffic of its own.

## Possible directions (from an outsider's read)

- Run the catch-up decode asynchronously / overlapped with the next target ubatch
  instead of synchronously between ubatches.
- Fuse the nextn-layer prompt pass into the target graph when the contexts live on the
  same devices (it already shares hidden states via the embd copy).
- Extend the `is_mem_shared` fast path to more architectures where the layout allows.

Happy to run patches or provide more measurements — the setup above is reproducible on
demand, including a second quant (Q8_0) and a dense-attention 7B for contrast.
