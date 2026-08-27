# llama-params snapshot (248 params)

Generated from `/home/james/projects/LLM-Tuner/llama.cpp/build/bin/llama-server --help` on 2026-08-27T21:39:18.429Z

## By scope
- server: 195
- request: 44
- archive: 9

## By group
- speed: 15
- memory: 16
- context: 14
- sampling: 36
- model: 57
- devices: 8
- speculative: 34
- server: 21
- agents: 4
- multimodal: 16
- chat: 10
- logging: 8
- archive: 9

## Params
| id | label | flags | group | scope | control | default | help |
|---|---|---|---|---|---|---|---|
| cpu_mask | CPU Mask | -C, --cpu-mask | speed | server | text |  | CPU affinity mask: arbitrarily long hex. |
| cpu_mask_batch | CPU Mask Batch | -Cb, --cpu-mask-batch | speed | server | text |  | CPU affinity mask: arbitrarily long hex. |
| cpu_range | CPU Range | -Cr, --cpu-range | speed | server | text |  | range of CPUs for affinity. |
| cpu_range_batch | CPU Range Batch | -Crb, --cpu-range-batch | speed | server | text |  | ranges of CPUs for affinity. |
| cpu_strict | CPU Strict | --cpu-strict | speed | server | enum | 0 | use strict CPU placement |
| cpu_strict_batch | CPU Strict Batch | --cpu-strict-batch | speed | server | enum |  | use strict CPU placement |
| no_cont_batching | No Cont Batching | -cb, --cont-batching, -nocb, --no-cont-batching | speed | server | toggle | enabled | whether to enable continuous batching (a.k.a dynamic batchin |
| parallel | Parallel | -np, --parallel | speed | server | int | -1 | number of server slots |
| poll | Poll | --poll | speed | server | text |  | use polling level to wait for work (0 - no polling, default: |
| poll_batch | Poll Batch | --poll-batch | speed | server | enum |  | use polling to wait for work |
| prio | Prio | --prio | speed | server | int | 0 | set process/thread priority : low(-1), normal(0), medium(1), |
| prio_batch | Prio Batch | --prio-batch | speed | server | int | 0 | set process/thread priority : 0-normal, 1-medium, 2-high, 3- |
| threads | Threads | -t, --threads | speed | server | int | -1 | number of CPU threads to use during generation |
| threads_batch | Threads Batch | -tb, --threads-batch | speed | server | text |  | number of threads to use during batch and prompt processing |
| threads_http | Threads Http | --threads-http | speed | server | int | -1 | number of threads used to process HTTP requests |
| cache_type_k_draft | Cache Type K Draft | --spec-draft-type-k, -ctkd, --cache-type-k-draft | memory | server | enum | f16 | KV cache data type for K for the draft model |
| cache_type_v_draft | Cache Type V Draft | --spec-draft-type-v, -ctvd, --cache-type-v-draft | memory | server | enum | f16 | KV cache data type for V for the draft model |
| check_tensors | Check Tensors | --check-tensors | memory | server | toggle | false | check model tensor data for invalid values |
| cpu_moe | CPU Moe | -cmoe, --cpu-moe | memory | server | text |  | keep all Mixture of Experts (MoE) weights in the CPU |
| fit | Fit | -fit, --fit | memory | server | enum |  | whether to adjust unset arguments to fit in device memory (' |
| fit_ctx | Fit CTX | -fitc, --fit-ctx | memory | server | text |  | minimum ctx size that can be set by --fit option, default: 4 |
| fit_target | Fit Target | -fitt, --fit-target | memory | server | list |  | target margin per device for --fit, comma-separated list of  |
| keep | Keep | --keep | memory | request | int | 0 | number of tokens to keep from the initial prompt |
| cache_type_k | KV cache type K | -ctk, --cache-type-k | memory | server | enum | f16 | KV cache data type for K |
| cache_type_v | KV cache type V | -ctv, --cache-type-v | memory | server | enum | f16 | KV cache data type for V |
| load_mode | Load Mode | -lm, --load-mode | memory | server | enum | auto | model loading mode - auto: mmap, unless a device does not su |
| n_cpu_moe | N CPU Moe | -ncmoe, --n-cpu-moe | memory | server | text |  | keep the Mixture of Experts (MoE) weights of the first N lay |
| no_host | No Host | --no-host | memory | server | toggle |  | bypass host buffer allowing extra buffers to be used |
| numa | NUMA | --numa | memory | server | text |  | attempt optimizations that help on some NUMA systems - distr |
| override_tensor | Override Tensor | -ot, --override-tensor | memory | server | text |  | override tensor buffer type |
| swa_full | Swa Full | --swa-full | memory | server | toggle | false | use full-size SWA cache [(more info)](https://github.com/ggm |
| batch_size | Batch Size | -b, --batch-size | context | server | int | 2048 | logical maximum batch size |
| cache_ram | Cache Ram | -cram, --cache-ram | context | server | int | 8192 | set the maximum cache size in MiB [(more info)](https://gith |
| checkpoint_min_step | Checkpoint Min Step | -cms, --checkpoint-min-step | context | server | int | 8192 | minimum spacing between context checkpoints in tokens |
| ctx_size | Context size | -c, --ctx-size | context | server | int | 0 | size of the prompt context |
| rope_freq_base | ROPE Freq Base | --rope-freq-base | context | server | text | loaded from model | RoPE base frequency, used by NTK-aware scaling |
| rope_freq_scale | ROPE Freq Scale | --rope-freq-scale | context | server | text |  | RoPE frequency scaling factor, expands context by a factor o |
| rope_scale | ROPE Scale | --rope-scale | context | server | text |  | RoPE context scaling factor, expands context by a factor of  |
| rope_scaling | ROPE Scaling | --rope-scaling | context | server | enum |  | RoPE frequency scaling method, defaults to linear unless spe |
| ubatch_size | Ubatch Size | -ub, --ubatch-size | context | server | int | 512 | physical maximum batch size |
| yarn_attn_factor | YARN Attn Factor | --yarn-attn-factor | context | server | int | -1 | YaRN: scale sqrt(t) or attention magnitude |
| yarn_beta_fast | YARN Beta Fast | --yarn-beta-fast | context | server | int | -1 | YaRN: low correction dim or beta |
| yarn_beta_slow | YARN Beta Slow | --yarn-beta-slow | context | server | int | -1 | YaRN: high correction dim or alpha |
| yarn_ext_factor | YARN Ext Factor | --yarn-ext-factor | context | server | int | -1 | YaRN: extrapolation mix factor |
| yarn_orig_ctx | YARN Orig CTX | --yarn-orig-ctx | context | server | int | 0 | YaRN: original context size of model |
| adaptive_decay | Adaptive Decay | --adaptive-decay | sampling | request | float | 0.9 | adaptive-p: decay rate for target adaptation over time. |
| adaptive_target | Adaptive Target | --adaptive-target | sampling | request | int | -1 | adaptive-p: select tokens near this probability (valid range |
| backend_sampling | Backend Sampling | -bs, --backend-sampling | sampling | request | toggle | disabled | enable backend sampling (experimental) |
| cache_reuse | Cache Reuse | --cache-reuse | sampling | request | int | 0 | min chunk size to attempt reusing from the cache via KV shif |
| dry_allowed_length | Dry Allowed Length | --dry-allowed-length | sampling | request | int | 2 | set allowed length for DRY sampling |
| dry_base | Dry Base | --dry-base | sampling | request | float | 1.75 | set DRY sampling base value |
| dry_multiplier | Dry Multiplier | --dry-multiplier | sampling | request | int | 0 | set DRY sampling multiplier |
| dry_penalty_last_n | Dry Penalty Last N | --dry-penalty-last-n | sampling | request | float | 64 | set DRY penalty for the last n tokens |
| dry_sequence_breaker | Dry Sequence Breaker | --dry-sequence-breaker | sampling | request | text |  | add sequence breaker for DRY sampling, clearing out default  |
| dynatemp_exp | Dynatemp Exp | --dynatemp-exp | sampling | request | float | 1 | dynamic temperature exponent |
| dynatemp_range | Dynatemp Range | --dynatemp-range | sampling | request | float | 0 | dynamic temperature range |
| frequency_penalty | Frequency Penalty | --frequency-penalty | sampling | request | float | 0 | repeat alpha frequency penalty |
| grammar | Grammar | --grammar | sampling | request | text |  | BNF-like grammar to constrain generations (see samples in gr |
| grammar_file | Grammar File | --grammar-file | sampling | request | path |  | file to read grammar from |
| ignore_eos | Ignore Eos | --ignore-eos | sampling | request | toggle |  | ignore end of stream token and continue generating (implies  |
| json_schema | Json Schema | -j, --json-schema | sampling | request | text |  | JSON schema to constrain generations (https://json-schema.or |
| json_schema_file | Json Schema File | -jf, --json-schema-file | sampling | request | path |  | File containing a JSON schema to constrain generations (http |
| logit_bias | Logit Bias | -l, --logit-bias | sampling | request | text |  | modifies the likelihood of token appearing in the completion |
| min_p | Min P | --min-p | sampling | request | float | 0.05 | min-p sampling |
| mirostat | Mirostat | --mirostat | sampling | request | int | 0 | use Mirostat sampling. |
| mirostat_ent | Mirostat Ent | --mirostat-ent | sampling | request | int | 5 | Mirostat target entropy, parameter tau |
| mirostat_lr | Mirostat Lr | --mirostat-lr | sampling | request | float | 0.1 | Mirostat learning rate, parameter eta |
| presence_penalty | Presence Penalty | --presence-penalty | sampling | request | float | 0 | repeat alpha presence penalty |
| repeat_last_n | Repeat Last N | --repeat-last-n | sampling | request | int | 64 | last n tokens to consider for penalize |
| repeat_penalty | Repeat Penalty | --repeat-penalty | sampling | request | float | 1 | penalize repeat sequence of tokens |
| samplers | Samplers | --samplers | sampling | request | text | penalties | samplers that will be used for generation in the order, sepa |
| sampling_seq | Sampling Seq | --sampler-seq, --sampling-seq | sampling | request | text | edskypmxt | simplified sequence for samplers that will be used |
| seed | Seed | -s, --seed | sampling | request | int | -1 | RNG seed |
| temperature | Temperature | --temp, --temperature | sampling | request | float | 0.8 | temperature |
| n_predict | Tokens to predict | -n, --predict, --n-predict | sampling | request | int | -1 | number of tokens to predict |
| top_k | Top K | --top-k | sampling | request | int | 40 | top-k sampling |
| top_n_sigma | Top N Sigma | --top-nsigma, --top-n-sigma | sampling | request | int | -1 | top-n-sigma sampling |
| top_p | Top P | --top-p | sampling | request | float | 0.95 | top-p sampling |
| typical_p | Typical P | --typical, --typical-p | sampling | request | float | 1 | locally typical sampling, parameter p |
| xtc_probability | Xtc Probability | --xtc-probability | sampling | request | float | 0 | xtc probability |
| xtc_threshold | Xtc Threshold | --xtc-threshold | sampling | request | float | 0.1 | xtc threshold |
| alias | Alias | -a, --alias | model | server | text |  | set model name aliases, comma-separated (to be used by API) |
| cache_list | Cache List | -cl, --cache-list | model | server | text |  | show list of models in cache |
| completion_bash | Completion Bash | --completion-bash | model | server | toggle |  | print source-able bash completion script for llama.cpp |
| control_vector | Control Vector | --control-vector | model | server | text |  | add a control vector note: use comma-separated values to add |
| control_vector_layer_range | Control Vector Layer Range | --control-vector-layer-range | model | server | text |  | layer range to apply the control vector(s) to, start and end |
| control_vector_scaled | Control Vector Scaled | --control-vector-scaled | model | server | text |  | add a control vector with user defined scaling SCALE note: u |
| docker_repo | Docker Repo | -dr, --docker-repo | model | server | text | unused | Docker Hub model repository. |
| embeddings | Embeddings | --embedding, --embeddings | model | server | toggle | disabled | restrict to only support embedding use case; use only with d |
| flash_attn | Flash Attn | -fa, --flash-attn | model | server | enum |  | set Flash Attention use ('on', 'off', or 'auto', default: 'a |
| gpt_oss_120b_default | Gpt Oss 120b Default | --gpt-oss-120b-default | model | server | toggle |  | use gpt-oss-120b (note: can download weights from the intern |
| gpt_oss_20b_default | Gpt Oss 20b Default | --gpt-oss-20b-default | model | server | toggle |  | use gpt-oss-20b (note: can download weights from the interne |
| hf_file | HF File | -hff, --hf-file | model | server | path | unused | Hugging Face model file. |
| hf_repo | HF Repo | -hf, -hfr, --hf-repo | model | server | text | unused | Hugging Face model repository; quant is optional, case-insen |
| hf_repo_draft | HF Repo Draft | --spec-draft-hf, -hfd, -hfrd, --hf-repo-draft | model | server | text | unused | Same as --hf-repo, but for the draft model |
| hf_token | HF Token | -hft, --hf-token | model | server | text | value from HF_TOKEN environment variable | Hugging Face access token |
| lookup_cache_dynamic | Lookup Cache Dynamic | -lcd, --lookup-cache-dynamic | model | server | path |  | path to dynamic lookup cache to use for lookup decoding (upd |
| lookup_cache_static | Lookup Cache Static | -lcs, --lookup-cache-static | model | server | path |  | path to static lookup cache to use for lookup decoding (not  |
| lora | LORA | --lora | model | server | path |  | path to LoRA adapter (use comma-separated values to load mul |
| lora_init_without_apply | LORA Init Without Apply | --lora-init-without-apply | model | server | toggle | disabled | load LoRA adapters without applying them (apply later via PO |
| lora_scaled | LORA Scaled | --lora-scaled | model | server | path |  | path to LoRA adapter with user defined scaling (format: FNAM |
| model | Model | -m, --model | model | server | path |  | model path to load |
| model_url | Model URL | -mu, --model-url | model | server | text | unused | model download url |
| no_agent | No Agent | -ag, --agent, -no-ag, --no-agent | model | server | toggle | disabled | whether to enable CORS proxy and all built-in tools - do not |
| no_cache_idle_slots | No Cache Idle Slots | --cache-idle-slots, --no-cache-idle-slots | model | server | toggle | enabled | save idle slots to the prompt cache on new task, and clear t |
| no_cache_prompt | No Cache Prompt | --cache-prompt, --no-cache-prompt | model | request | toggle | enabled | whether to enable prompt caching |
| no_context_shift | No Context Shift | --context-shift, --no-context-shift | model | server | toggle | disabled | whether to use context shift on infinite text generation |
| no_cors_credentials | No Cors Credentials | --cors-credentials, --no-cors-credentials | model | server | toggle | enabled | whether to allow credentials for CORS note: if this is enabl |
| no_escape | No Escape | -e, --escape, --no-escape | model | server | toggle | true | whether to process escapes sequences (\n, \r, \t, \', \", \\ |
| no_jinja | No JINJA | --jinja, --no-jinja | model | server | toggle | enabled | whether to use jinja template engine for chat |
| no_kv_offload | No KV Offload | -kvo, --kv-offload, -nkvo, --no-kv-offload | model | server | toggle | enabled | whether to enable KV cache offloading |
| no_kv_unified | No KV Unified | -kvu, --kv-unified, -no-kvu, --no-kv-unified | model | server | text | enabled if number of slots is auto | use single unified KV buffer shared across all sequences |
| no_log_prefix | No Log Prefix | --log-prefix, --no-log-prefix | model | server | text |  | Enable prefix in log messages |
| no_log_timestamps | No Log Timestamps | --log-timestamps, --no-log-timestamps | model | server | text |  | Enable timestamps in log messages |
| no_mmproj_auto | No MMPROJ Auto | --mmproj-auto, --no-mmproj, --no-mmproj-auto | model | server | toggle | enabled | whether to use multimodal projector file (if available), use |
| no_mmproj_offload | No MMPROJ Offload | --mmproj-offload, --no-mmproj-offload | model | server | toggle | enabled | whether to enable GPU offloading for multimodal projector |
| no_models_autoload | No Models Autoload | --models-autoload, --no-models-autoload | model | server | toggle | enabled | for router server, whether to automatically load models |
| no_op_offload | No Op Offload | --op-offload, --no-op-offload | model | server | toggle | true | whether to offload host tensor operations to device |
| no_perf | No Perf | --perf, --no-perf | model | server | toggle | false | whether to enable internal libllama performance timings |
| no_prefill_assistant | No Prefill Assistant | --prefill-assistant, --no-prefill-assistant | model | server | text | prefill enabled | whether to prefill the assistant's response if the last mess |
| no_repack | No Repack | --repack, -nr, --no-repack | model | server | toggle | enabled | whether to enable weight repacking |
| no_slots | No Slots | --slots, --no-slots | model | server | toggle | enabled | expose slots monitoring endpoint |
| no_warmup | No Warmup | --warmup, --no-warmup | model | server | toggle | enabled | whether to perform warmup with an empty run |
| no_webui | No Webui | --ui, --webui, --no-ui, --no-webui | model | server | toggle | enabled | whether to enable the Web UI |
| no_webui_mcp_proxy | No Webui MCP Proxy | --ui-mcp-proxy, --webui-mcp-proxy, --no-ui-mcp-proxy, --no-webui-mcp-proxy | model | server | toggle | disabled | experimental: whether to enable MCP CORS proxy - do not enab |
| override_kv | Override KV | --override-kv | model | server | text |  | advanced option to override model metadata by key. |
| reverse_prompt | Reverse Prompt | -r, --reverse-prompt | model | server | text |  | halt generation at PROMPT, return control in interactive mod |
| sleep_idle_seconds | Sleep Idle Seconds | --sleep-idle-seconds | model | server | int | -1 | number of seconds of idleness after which the server will sl |
| slot_prompt_similarity | Slot Prompt Similarity | -sps, --slot-prompt-similarity | model | server | float | 0.1 | how much the prompt of a request must match the prompt of a  |
| spm_infill | Spm Infill | --spm-infill | model | server | toggle | disabled | use Suffix/Prefix/Middle pattern for infill (instead of Pref |
| swa_checkpoints | Swa Checkpoints | -ctxcp, --ctx-checkpoints, --swa-checkpoints | model | server | int | 32 | max number of context checkpoints to create per slot [(more  |
| tags | Tags | --tags | model | server | text |  | set model tags, comma-separated (informational, not used for |
| usage | Usage | -h, --help, --usage | model | server | text |  | print usage and exit |
| version | Version | --version | model | server | toggle |  | show version and build info |
| vision_gemma_12b_default | Vision Gemma 12b Default | --vision-gemma-12b-default | model | server | toggle |  | use Gemma 3 12B QAT (note: can download weights from the int |
| vision_gemma_4b_default | Vision Gemma 4b Default | --vision-gemma-4b-default | model | server | toggle |  | use Gemma 3 4B QAT (note: can download weights from the inte |
| webui_config | Webui Config | --ui-config, --webui-config | model | server | text |  | JSON that provides default UI settings (overrides UI default |
| webui_config_file | Webui Config File | --ui-config-file, --webui-config-file | model | server | path |  | JSON file that provides default UI settings (overrides UI de |
| device | Device | -dev, --device | devices | server | list |  | comma-separated list of devices to use for offloading (none  |
| device_draft | Device Draft | --spec-draft-device, -devd, --device-draft | devices | server | list |  | comma-separated list of devices to use for offloading the dr |
| n_gpu_layers | GPU layers | -ngl, --gpu-layers, --n-gpu-layers | devices | server | enum | auto | max. |
| list_devices | List Devices | --list-devices | devices | server | toggle |  | print list of available devices and exit |
| main_gpu | Main GPU | -mg, --main-gpu | devices | server | int | 0 | the GPU to use for the model (with split-mode = none), or fo |
| n_gpu_layers_draft | N GPU Layers Draft | --spec-draft-ngl, -ngld, --gpu-layers-draft, --n-gpu-layers-draft | devices | server | enum | auto | max. |
| split_mode | Split mode | -sm, --split-mode | devices | server | enum |  | how to split the model across multiple GPUs, one of: - none: |
| tensor_split | Tensor split | -ts, --tensor-split | devices | server | list |  | fraction of the model to offload to each GPU, comma-separate |
| cpu_mask_batch_draft | CPU Mask Batch Draft | --spec-draft-cpu-mask-batch, -Cbd, --cpu-mask-batch-draft | speculative | server | text |  | Draft model CPU affinity mask. |
| cpu_mask_draft | CPU Mask Draft | --spec-draft-cpu-mask, -Cd, --cpu-mask-draft | speculative | server | text |  | Draft model CPU affinity mask. |
| cpu_moe_draft | CPU Moe Draft | --spec-draft-cpu-moe, -cmoed, --cpu-moe-draft | speculative | server | text |  | keep all Mixture of Experts (MoE) weights in the CPU for the |
| cpu_range_draft | CPU Range Draft | --spec-draft-cpu-range, -Crd, --cpu-range-draft | speculative | server | text |  | Ranges of CPUs for affinity. |
| cpu_strict_batch_draft | CPU Strict Batch Draft | --spec-draft-cpu-strict-batch, --cpu-strict-batch-draft | speculative | server | enum |  | Use strict CPU placement for draft model |
| cpu_strict_draft | CPU Strict Draft | --spec-draft-cpu-strict, --cpu-strict-draft | speculative | server | enum |  | Use strict CPU placement for draft model |
| draft_p_min | Draft P Min | --spec-draft-p-min, --draft-p-min | speculative | server | int | 0 | minimum speculative decoding probability (greedy) |
| draft_p_split | Draft P Split | --spec-draft-p-split, --draft-p-split | speculative | server | float | 0.1 | speculative decoding split probability |
| model_draft | Model Draft | --spec-draft-model, -md, --model-draft | speculative | server | text | unused | draft model for speculative decoding |
| n_cpu_moe_draft | N CPU Moe Draft | --spec-draft-n-cpu-moe, --spec-draft-ncmoe, -ncmoed, --n-cpu-moe-draft | speculative | server | text |  | keep the Mixture of Experts (MoE) weights of the first N lay |
| no_spec_draft_backend_sampling | No Spec Draft Backend Sampling | --spec-draft-backend-sampling, --no-spec-draft-backend-sampling | speculative | server | toggle | enabled | offload draft sampling to the backend |
| override_tensor_draft | Override Tensor Draft | --spec-draft-override-tensor, -otd, --override-tensor-draft | speculative | server | text |  | override tensor buffer type for draft model |
| poll_batch_draft | Poll Batch Draft | --spec-draft-poll-batch, --poll-batch-draft | speculative | server | enum |  | Use polling to wait for draft model work |
| poll_draft | Poll Draft | --spec-draft-poll, --poll-draft | speculative | server | enum |  | Use polling to wait for draft model work |
| prio_batch_draft | Prio Batch Draft | --spec-draft-prio-batch, --prio-batch-draft | speculative | server | int | 0 | set draft process/thread priority : 0-normal, 1-medium, 2-hi |
| prio_draft | Prio Draft | --spec-draft-prio, --prio-draft | speculative | server | int | 0 | set draft process/thread priority : 0-normal, 1-medium, 2-hi |
| spec_default | Spec Default | --spec-default | speculative | server | toggle |  | enable default speculative decoding config |
| spec_draft_n_max | Spec Draft N Max | --spec-draft-n-max | speculative | server | int | 3 | number of tokens to draft for speculative decoding |
| spec_draft_n_min | Spec Draft N Min | --spec-draft-n-min | speculative | server | int | 0 | minimum number of draft tokens to use for speculative decodi |
| spec_ngram_map_k_min_hits | Spec Ngram Map K Min Hits | --spec-ngram-map-k-min-hits | speculative | server | int | 1 | minimum hits for ngram-map-k speculative decoding |
| spec_ngram_map_k_size_m | Spec Ngram Map K Size M | --spec-ngram-map-k-size-m | speculative | server | int | 48 | ngram size M for ngram-map-k speculative decoding, length of |
| spec_ngram_map_k_size_n | Spec Ngram Map K Size N | --spec-ngram-map-k-size-n | speculative | server | int | 12 | ngram size N for ngram-map-k speculative decoding, length of |
| spec_ngram_map_k4v_min_hits | Spec Ngram Map K4v Min Hits | --spec-ngram-map-k4v-min-hits | speculative | server | int | 1 | minimum hits for ngram-map-k4v speculative decoding |
| spec_ngram_map_k4v_size_m | Spec Ngram Map K4v Size M | --spec-ngram-map-k4v-size-m | speculative | server | int | 48 | ngram size M for ngram-map-k4v speculative decoding, length  |
| spec_ngram_map_k4v_size_n | Spec Ngram Map K4v Size N | --spec-ngram-map-k4v-size-n | speculative | server | int | 12 | ngram size N for ngram-map-k4v speculative decoding, length  |
| spec_ngram_mod_n_match | Spec Ngram Mod N Match | --spec-ngram-mod-n-match | speculative | server | int | 24 | ngram-mod lookup length |
| spec_ngram_mod_n_max | Spec Ngram Mod N Max | --spec-ngram-mod-n-max | speculative | server | int | 64 | maximum number of ngram tokens to use for ngram-based specul |
| spec_ngram_mod_n_min | Spec Ngram Mod N Min | --spec-ngram-mod-n-min | speculative | server | int | 48 | minimum number of ngram tokens to use for ngram-based specul |
| spec_ngram_simple_min_hits | Spec Ngram Simple Min Hits | --spec-ngram-simple-min-hits | speculative | server | int | 1 | minimum hits for ngram-simple speculative decoding |
| spec_ngram_simple_size_m | Spec Ngram Simple Size M | --spec-ngram-simple-size-m | speculative | server | int | 48 | ngram size M for ngram-simple speculative decoding, length o |
| spec_ngram_simple_size_n | Spec Ngram Simple Size N | --spec-ngram-simple-size-n | speculative | server | int | 12 | ngram size N for ngram-simple speculative decoding, length o |
| spec_type | Spec Type | --spec-type | speculative | server | list | none | comma-separated list of types of speculative decoding to use |
| threads_batch_draft | Threads Batch Draft | --spec-draft-threads-batch, -tbd, --threads-batch-draft | speculative | server | text |  | number of threads to use during batch and prompt processing |
| threads_draft | Threads Draft | --spec-draft-threads, -td, --threads-draft | speculative | server | text |  | number of threads to use during generation |
| api_key | API Key | --api-key | server | server | list | none | API key to use for authentication, multiple keys can be prov |
| api_key_file | API Key File | --api-key-file | server | server | path | none | path to file containing API keys, one per line; lines starti |
| api_prefix | API Prefix | --api-prefix | server | server | text |  | prefix path the server serves from, without the trailing sla |
| cors_headers | Cors Headers | --cors-headers | server | server | list | * | comma-separated list of allowed headers for CORS |
| cors_methods | Cors Methods | --cors-methods | server | server | list | GET | comma-separated list of allowed methods for CORS |
| cors_origins | Cors Origins | --cors-origins | server | server | list | * | comma-separated list of allowed origins for CORS if set to s |
| host | Host | --host | server | server | text | 127.0.0.1 | ip address to listen, or bind to an UNIX socket if the addre |
| media_path | Media Path | --media-path | server | server | path | disabled | directory for loading local media files; files can be access |
| metrics | Metrics | --metrics | server | server | toggle | disabled | enable prometheus compatible metrics endpoint |
| models_dir | Models Dir | --models-dir | server | server | path | disabled | directory containing models for the router server |
| models_max | Models Max | --models-max | server | server | int | 4 | for router server, maximum number of models to load simultan |
| models_preset | Models Preset | --models-preset | server | server | path | disabled | path to INI file containing model presets for the router ser |
| path | Path | --path | server | server | path |  | path to serve static files from |
| port | Port | --port | server | server | int | 8080 | port to listen |
| props | Props | --props | server | server | toggle | disabled | enable changing global properties via POST /props |
| reuse_port | Reuse Port | --reuse-port | server | server | toggle | disabled | allow multiple sockets to bind to the same port |
| slot_save_path | Slot Save Path | --slot-save-path | server | server | path | disabled | path to save slot kv cache |
| sse_ping_interval | Sse Ping Interval | --sse-ping-interval | server | server | text |  | server SSE ping interval in seconds (-1 = disabled, default: |
| ssl_cert_file | SSL Cert File | --ssl-cert-file | server | server | path |  | path to file a PEM-encoded SSL certificate |
| ssl_key_file | SSL Key File | --ssl-key-file | server | server | path |  | path to file a PEM-encoded SSL private key |
| timeout | Timeout | -to, --timeout | server | server | int | 3600 | server read/write timeout in seconds |
| mcp_servers_config | MCP Servers Config | --mcp-servers-config | agents | server | path | none | experimental: path to JSON file with MCP server definitions  |
| mcp_servers_json | MCP Servers Json | --mcp-servers-json | agents | server | enum | none | experimental: inline JSON with MCP server definitions (Curso |
| tools | Tools | --tools | agents | server | text | no tools | experimental: whether to enable built-in tools for AI agents |
| tools_runtime | Tools Runtime | --tools-runtime | agents | server | enum | none | experimental: run tools in a separate runtime environment av |
| embd_gemma_default | Embd Gemma Default | --embd-gemma-default | multimodal | server | toggle |  | use default EmbeddingGemma model (note: can download weights |
| embd_normalize | Embd Normalize | --embd-normalize | multimodal | server | int | 2 | normalisation for embeddings (-1=none, 0=max absolute int16, |
| fim_qwen_1 | FIM Qwen 1 | --fim-qwen-1 | multimodal | server | text |  | use default Qwen 2.5 Coder 1.5B (note: can download weights  |
| fim_qwen_14b_spec | FIM Qwen 14b Spec | --fim-qwen-14b-spec | multimodal | server | toggle |  | use Qwen 2.5 Coder 14B + 0.5B draft for speculative decoding |
| fim_qwen_30b_default | FIM Qwen 30b Default | --fim-qwen-30b-default | multimodal | server | toggle |  | use default Qwen 3 Coder 30B A3B Instruct (note: can downloa |
| fim_qwen_3b_default | FIM Qwen 3b Default | --fim-qwen-3b-default | multimodal | server | toggle |  | use default Qwen 2.5 Coder 3B (note: can download weights fr |
| fim_qwen_7b_default | FIM Qwen 7b Default | --fim-qwen-7b-default | multimodal | server | toggle |  | use default Qwen 2.5 Coder 7B (note: can download weights fr |
| fim_qwen_7b_spec | FIM Qwen 7b Spec | --fim-qwen-7b-spec | multimodal | server | toggle |  | use Qwen 2.5 Coder 7B + 0.5B draft for speculative decoding  |
| image_max_tokens | Image Max Tokens | --image-max-tokens | multimodal | server | text | read from model | maximum number of tokens each image can take, only used by v |
| image_min_tokens | Image Min Tokens | --image-min-tokens | multimodal | server | text | read from model | minimum number of tokens each image can take, only used by v |
| mmproj | MMPROJ | -mm, --mmproj | multimodal | server | path |  | path to a multimodal projector file. |
| mmproj_device | MMPROJ Device | -mmdev, --mmproj-device | multimodal | server | text |  | device to use for multimodal projector (none = don't offload |
| mmproj_url | MMPROJ URL | -mmu, --mmproj-url | multimodal | server | text |  | URL to a multimodal projector file. |
| mtmd_batch_max_tokens | Mtmd Batch Max Tokens | --mtmd-batch-max-tokens | multimodal | server | int | 1024 | maximum number of image tokens per batch when encoding image |
| pooling | Pooling | --pooling | multimodal | server | enum |  | pooling type for embeddings, use model default if unspecifie |
| reranking | Reranking | --rerank, --reranking | multimodal | server | toggle | disabled | enable reranking endpoint on server |
| chat_template | Chat Template | --chat-template | chat | server | text | template taken from model's metadata | set custom jinja chat template if suffix/prefix are specifie |
| chat_template_file | Chat Template File | --chat-template-file | chat | server | path | template taken from model's metadata | set custom jinja chat template file if suffix/prefix are spe |
| chat_template_kwargs | Chat Template Kwargs | --chat-template-kwargs | chat | request | text |  | sets additional params for the json template parser, must be |
| no_skip_chat_parsing | No Skip Chat Parsing | --skip-chat-parsing, --no-skip-chat-parsing | chat | server | toggle | disabled | force a pure content parser, even if a Jinja template is spe |
| reasoning | Reasoning | -rea, --reasoning | chat | request | enum |  | Use reasoning/thinking in the chat ('on', 'off', or 'auto',  |
| reasoning_budget | Reasoning Budget | --reasoning-budget | chat | request | int | -1 | token budget for thinking: -1 for unrestricted, 0 for immedi |
| reasoning_budget_message | Reasoning Budget Message | --reasoning-budget-message | chat | request | enum | none | message injected before the end-of-thinking tag when reasoni |
| reasoning_effort | Reasoning Effort | --reasoning-effort | chat | request | text | default | reasoning effort level given to the chat template: 'default' |
| reasoning_format | Reasoning Format | --reasoning-format | chat | request | enum | auto | controls whether thought tags are allowed and/or extracted f |
| no_reasoning_preserve | Reasoning Preserve | --reasoning-preserve, --no-reasoning-preserve | chat | server | toggle | false | preserve reasoning trace in the full history, not just the l |
| log_colors | Log Colors | --log-colors | logging | server | enum |  | Set colored logging ('on', 'off', or 'auto', default: 'auto' |
| log_disable | Log Disable | --log-disable | logging | server | toggle |  | Log disable |
| log_file | Log File | --log-file | logging | server | path |  | Log to file |
| log_prompts_dir | Log Prompts Dir | --log-prompts-dir | logging | server | path |  | Log prompts to directory (auto-created if not present; only  |
| log_verbose | Log Verbose | -v, --verbose, --log-verbose | logging | server | text |  | Set verbosity level to infinity (i.e. |
| log_verbosity | Log Verbosity | -lv, --verbosity, --log-verbosity | logging | server | int | 3 | Set the verbosity threshold. |
| offline | Offline | --offline | logging | server | toggle |  | Offline mode: forces use of cache, prevents network access |
| special | Special | -sp, --special | logging | server | toggle | false | special tokens output enabled |
| defrag_thold | Defrag Thold | -dt, --defrag-thold | archive | archive | text |  | KV cache defragmentation threshold (DEPRECATED) |
| draft_max | Draft Max | --draft, --draft-n, --draft-max | archive | archive | text |  | the argument has been removed. |
| draft_n_min | Draft N Min | --draft-min, --draft-n-min | archive | archive | text |  | the argument has been removed. |
| mlock | Mlock | --mlock | archive | archive | toggle |  | DEPRECATED in favor of `--load-mode`: force system to keep m |
| no_direct_io | No Direct Io | -dio, --direct-io, -ndio, --no-direct-io | archive | archive | text |  | DEPRECATED in favor of `--load-mode`: use DirectIO if availa |
| no_mmap | No Mmap | --mmap, --no-mmap | archive | archive | text |  | DEPRECATED in favor of `--load-mode`: whether to memory-map  |
| spec_ngram_min_hits | Spec Ngram Min Hits | --spec-ngram-min-hits | archive | archive | text |  | the argument has been removed. |
| spec_ngram_size_m | Spec Ngram Size M | --spec-ngram-size-m | archive | archive | text |  | the argument has been removed. |
| spec_ngram_size_n | Spec Ngram Size N | --spec-ngram-size-n | archive | archive | text |  | the argument has been removed. |
