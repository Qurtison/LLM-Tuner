# Draft GitHub issue — review and edit into your own words before posting
# (their rules prohibit AI-drafted issues; treat this as notes/structure,
#  rewrite anything that doesn't sound like you)

Title: Eval bug: draft-mtp roughly halves prompt processing on multi-GPU layer split (single GPU is fine)

## What happens

With `--spec-type draft-mtp` enabled, prompt processing drops to roughly half speed
whenever the model is split across two GPUs with `--split-mode layer`. On a single GPU
the overhead is small. Same model file, same flags, only the device assignment changes.

I went down a few wrong paths on this (thought it was my eGPU, then thought it was
CUDA-specific) so I ended up with a fairly complete matrix. 22k token cold prompt,
prompt eval t/s from server timings:

| config | no MTP | draft-mtp | slowdown |
|---|---|---|---|
| Qwen3.8-27B Q3_K_XL, RTX 4090 solo (CUDA) | 766 | 742 | 1.03x |
| Qwen3.8-27B Q3_K_XL, 7900 XTX solo (Vulkan) | 572 | 505 | 1.13x |
| Qwen3.6-35B-A3B Q4_K_M, 7900 XTX solo | 1593 | 1307 | 1.22x |
| Qwen3.8-27B Q6_K_XL, CUDA0+Vulkan2 layer split | 973 | 532 | 1.83x |
| Qwen3.8-27B Q3_K_XL, CUDA0+Vulkan2 layer split | 1007 | 555 | 1.82x |
| Qwen3.8-27B Q6_K_XL, Vulkan1+Vulkan2 layer split | 754 | 376 | 2.0x |

("no MTP" rows use --spec-type ngram-map-k4v, which doesn't touch prefill and matches
the no-spec prefill rate. Last row is the same NVIDIA card via Vulkan instead of CUDA,
so no CUDA anywhere and it's still 2x.)

The `graphs reused` counter roughly halves with MTP on in every config (e.g. 960 ->
425 on the CUDA split pair, 897 -> 346 on Vulkan solo), but that on its own doesn't
seem to cost much — the solo rows eat the same reuse loss and barely slow down. The
expensive part only shows up when the layers are split across devices.

## Why I think this happens

In common/speculative.cpp the MTP process() hook runs a synchronous catch-up decode in
the draft context for every prefill ubatch (unless the model is mem-shared — the
"e.g Gemma4" comment). On a layer split that means every ubatch the pipeline between
the two GPUs gets broken by a decode on another context, so the ubatch overlap
(GGML_SCHED_MAX_COPIES) never gets going. That would explain why single GPU is nearly
free but any split pays ~2x regardless of backend.

## Environment

- build 10499 (6d0549831), also reproduced on 6c8dcaa7a from Aug 3 — not recent
- Linux, CUDA 12.0 + Vulkan build
- RTX 4090 Laptop 16GB (internal) + RX 7900 XTX 24GB (RADV)
- models: unsloth Qwen3.8-27B-GGUF (Q6_K_XL / Q3_K_XL), Qwen3.6-35B-A3B Q4_K_M —
  all with nextn_predict_layers=1
- -fa on, -ctk q8_0 -ctv q8_0

## Repro

```
# fast prefill:
llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf -c 262144 -ngl 999 -fa on \
  -ctk q8_0 -ctv q8_0 --spec-type ngram-map-k4v \
  --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60 --jinja

# ~half speed prefill, only --spec-type changed:
llama-server ... --spec-type draft-mtp --spec-draft-n-max 3 ...
```

Send any large cold prompt to both and compare `prompt eval time` in the timings.

## Related

Possibly connected to #26750 (draft-mtp acceptance collapse on CUDA vs Vulkan) — I can
reproduce that one too on this hardware btw (41% acceptance CUDA solo vs 64% Vulkan
solo, same Q3 file), though it's a different symptom (decode quality vs prefill speed).
Also #27306 crashes in the same draft-mtp prompt path on RADV.

Tried `--spec-draft-device CUDA0` on the split as a workaround — helps a little
(532 -> 573) but doesn't recover the loss, so it doesn't look like it's about where
the draft context lives; the per-ubatch interruption of the target pipeline seems to
be the cost either way.

Happy to test patches, all of the above takes me ~10 min to rerun.

## Relevant log output (paste into the template field)

```
LAUNCHING: llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf ... --spec-type ngram-map-k4v ... --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60
slot print_timing: id  0 | task 0 | prompt eval time =   22896.31 ms / 22284 tokens (    1.03 ms per token,   973.25 tokens per second)

LAUNCHING: llama-server -m Qwen3.8-27B-UD-Q6_K_XL.gguf ... --spec-type draft-mtp --spec-draft-n-max 3 ... --split-mode layer -dev CUDA0,Vulkan2 -ts 40,60
slot print_timing: id  0 | task 0 | prompt eval time =   41862.44 ms / 22284 tokens (    1.88 ms per token,   532.33 tokens per second)

# same pair, single GPU (CUDA solo) -- overhead nearly gone:
LAUNCHING: llama-server -m Qwen3.8-27B-UD-Q3_K_XL.gguf -c 32768 ... --spec-type ngram-map-k4v -dev CUDA0
slot print_timing: id  0 | task 0 | prompt eval time =   29107.44 ms / 22284 tokens (    1.31 ms per token,   765.58 tokens per second)

LAUNCHING: llama-server -m Qwen3.8-27B-UD-Q3_K_XL.gguf -c 24576 ... --spec-type draft-mtp --spec-draft-n-max 3 -dev CUDA0
slot print_timing: id  0 | task 0 | prompt eval time =   30032.87 ms / 22284 tokens (    1.35 ms per token,   742.03 tokens per second)

# graphs reused, with vs without mtp (Vulkan solo):
slot print_timing: id  0 | task 0 |    graphs reused =        897   (ngram)
slot print_timing: id  0 | task 0 |    graphs reused =        346   (draft-mtp)
```

(NOTE: the two Q6-split prompt-eval lines above are reconstructed from the measured
rates — pull the real ones from your logs before posting, or rerun the pair; the Q3
lines are real. Check `logs/` or the dashboard Master Logs.)
