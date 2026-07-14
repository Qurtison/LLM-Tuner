- make a noise when model is loaded.
- make a noise when model error.
- make a noise when thinking starts.
- make a noise when response finished.

---

TB ip address is hardcoded and surely incorrect... this needs to be made
dynamic... is it possible to make the ip address lookup dynamic for other
computer ont he network? perhaps a dropdown selectable list? and localstorage
preference pre-select for the last chosen one?

---

PROMPTING: hardware config section (including rpc) should all be grayed out once
we click 'launch model'

'booting' shouldn't be small gray text

I still don't see a stream for the master logs here. did we still not add that?

---

We desperately need to refactor to better code.

---

Ability to start multiple models.

Standardized test prompts.

automated model switching.

More params! All the params! e.g. where is verbosity? Where is temperature?

Custom command entry text box for start args?

These should be 'cached' per-model.

---

video and text ingestion.

---

It's seemingly mobile responsive, except when you click a chat, the chat becomes
full screen and isn't scrollable.

---

0.00.223.887 I cmn common_param: common_params_print_info: verbosity = 3 (adjust
with the `-lv N` CLI arg) 0.00.372.421 I srv load_model: loading model
'/models/Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf' 25.03.179.968 I srv load_model:
initializing, n_slots = 4, n_ctx_slot = 120064, kv_unified = 'true'
25.03.197.750 I srv init: chat template supports preserving reasoning, consider
enabling it via --reasoning-preserve 25.03.197.812 I srv llama_server: model
loaded 25.03.197.819 I srv llama_server: listening on http://0.0.0.0:8080
26.29.651.017 I slot get_availabl: id 3 | task -1 | selected slot by LRU, t_last
= -1 26.29.651.125 I slot launch_slot_: id 3 | task 0 | processing task,
is_child = 0 26.38.638.489 I slot print_timing: id 3 | task 0 | prompt
processing, n_tokens = 2048, progress = 0.07, t = 8.99 s / 227.88 tokens per
second 26.47.668.818 I slot print_timing: id 3 | task 0 | prompt processing,
n_tokens = 4096, progress = 0.13, t = 18.02 s / 227.34 tokens per second
26.57.410.012 I slot print_timing: id 3 | task 0 | prompt processing, n_tokens =
6144, progress = 0.20, t = 27.76 s / 221.34 tokens per second 27.07.990.729 I
slot print_timing: id 3 | task 0 | prompt processing, n_tokens = 8192, progress
= 0.26, t = 38.34 s / 213.67 tokens per second 27.19.806.513 I slot
print_timing: id 3 | task 0 | prompt processing, n_tokens = 10240, progress =
0.33, t = 50.16 s / 204.17 tokens per second 27.32.680.545 I slot print_timing:
id 3 | task 0 | prompt processing, n_tokens = 12288, progress = 0.39, t = 63.03
s / 194.96 tokens per second 27.45.771.820 I slot print_timing: id 3 | task 0 |
prompt processing, n_tokens = 14336, progress = 0.46, t = 76.12 s / 188.33
tokens per second 28.02.538.398 I slot print_timing: id 3 | task 0 | prompt
processing, n_tokens = 16384, progress = 0.52, t = 92.89 s / 176.39 tokens per
second 28.19.721.922 I slot print_timing: id 3 | task 0 | prompt processing,
n_tokens = 18432, progress = 0.59, t = 110.07 s / 167.46 tokens per second

^we have this rich output that we're ignoring during the prefill stage, that
tells us how full the progress bar should be, and gives us a t/s number we could
be showing in our metrics on the right...

but in fact, our yellow/blue/green bar should be updated to be a graph. It
should produce a line that goes up for higher t/s and down for lower t/s, but
the time passed ratios should still match just what we have, the labels
underneath should remain, and the colors should still be used.

we also should add a toggle for reasoning-preserve and a field to enter a value
for verbosity and support those.

---

For the Qwen 27b models:

To run in llama.cpp: apt-get update apt-get install pciutils build-essential
cmake curl libcurl4-openssl-dev -y git clone
https://github.com/ggml-org/llama.cpp cmake llama.cpp -B llama.cpp/build\
-DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON cmake --build llama.cpp/build --config
Release -j --clean-first --target llama-cli llama-mtmd-cli llama-server
llama-gguf-split cp llama.cpp/build/bin/llama-* llama.cpp

export LLAMA_CACHE="unsloth/Qwen3.6-27B-MTP-GGUF" ./llama.cpp/llama-server\
-hf unsloth/Qwen3.6-27B-MTP-GGUF:UD-Q4_K_XL\
-ngl 99 -c 8192 -fa on -np 1\
--spec-type draft-mtp --spec-draft-n-max 2

Set -DGGML_CUDA=OFF for CPU/Metal. -np > 1 and --mmproj are not yet supported
with MTP.

---

---

We're not 'preserving memory' right for qwen models...

> Thinking Preservation: we've introduced a new option to retain reasoning
> context from historical messages, streamlining iterative development and
> reducing overhead.

---

qwen 3.6 27b specific instructions:

We recommend using the following set of sampling parameters for generation

Thinking mode for general tasks: temperature=1.0, top_p=0.95, top_k=20,
min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Thinking mode for
precise coding tasks (e.g. WebDev): temperature=0.6, top_p=0.95, top_k=20,
min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Instruct (or
non-thinking) mode: temperature=0.7, top_p=0.80, top_k=20, min_p=0.0,
presence_penalty=1.5, repetition_penalty=1.0 Please note that the support for
sampling parameters varies according to inference frameworks.

---

Best Practices To achieve optimal performance, we recommend the following
settings:

Sampling Parameters:

We suggest using the following sets of sampling parameters depending on the mode
and task type: Thinking mode for general tasks: temperature=1.0, top_p=0.95,
top_k=20, min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Thinking mode
for precise coding tasks (e.g., WebDev): temperature=0.6, top_p=0.95, top_k=20,
min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Instruct (or
non-thinking) mode: temperature=0.7, top_p=0.80, top_k=20, min_p=0.0,
presence_penalty=1.5, repetition_penalty=1.0 For supported frameworks, you can
adjust the presence_penalty parameter between 0 and 2 to reduce endless
repetitions. However, using a higher value may occasionally result in language
mixing and a slight decrease in model performance. Adequate Output Length: We
recommend using an output length of 32,768 tokens for most queries. For
benchmarking on highly complex problems, such as those found in math and
programming competitions, we suggest setting the max output length to 81,920
tokens. This provides the model with sufficient space to generate detailed and
comprehensive responses, thereby enhancing its overall performance.

Standardize Output Format: We recommend using prompts to standardize model
outputs when benchmarking.

Math Problems: Include "Please reason step by step, and put your final answer
within \boxed{}." in the prompt. Multiple-Choice Questions: Add the following
JSON structure to the prompt to standardize responses: "Please show your choice
in the answer field with only the choice letter, e.g., "answer": "C"." Long
Video Understanding: To optimize inference efficiency for plain text and images,
the size parameter in the released video_preprocessor_config.json is
conservatively configured. It is recommended to set the longest_edge parameter
in the video_preprocessor_config file to 469,762,048 (corresponding to 224k
video tokens) to enable higher frame-rate sampling for hour-scale videos and
thereby achieve superior performance. For example,

{"longest_edge": 469762048, "shortest_edge": 4096}

Alternatively, override the default values via engine startup parameters. For
implementation details, refer to: vLLM / SGLang.

---

code highlighting

---

Code editor mode experiment. Select a folder.

- 'switch to editor view' produces a new view, with files on the left, code in
  the center, and chatbot text on the right.
- select a folder, files in that folder load on the left. Folders also show, and
  clicking them recursively loads the files in that folder.
- to the left of every folder indicate which ones to feed into context.

---

We're not 'preserving memory' right for qwen models...

> Thinking Preservation: we've introduced a new option to retain reasoning
> context from historical messages, streamlining iterative development and
> reducing overhead.

---

qwen 3.6 27b specific instructions:

We recommend using the following set of sampling parameters for generation

Thinking mode for general tasks: temperature=1.0, top_p=0.95, top_k=20,
min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Thinking mode for
precise coding tasks (e.g. WebDev): temperature=0.6, top_p=0.95, top_k=20,
min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Instruct (or
non-thinking) mode: temperature=0.7, top_p=0.80, top_k=20, min_p=0.0,
presence_penalty=1.5, repetition_penalty=1.0 Please note that the support for
sampling parameters varies according to inference frameworks.

---

Best Practices To achieve optimal performance, we recommend the following
settings:

Sampling Parameters:

We suggest using the following sets of sampling parameters depending on the mode
and task type: Thinking mode for general tasks: temperature=1.0, top_p=0.95,
top_k=20, min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Thinking mode
for precise coding tasks (e.g., WebDev): temperature=0.6, top_p=0.95, top_k=20,
min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0 Instruct (or
non-thinking) mode: temperature=0.7, top_p=0.80, top_k=20, min_p=0.0,
presence_penalty=1.5, repetition_penalty=1.0 For supported frameworks, you can
adjust the presence_penalty parameter between 0 and 2 to reduce endless
repetitions. However, using a higher value may occasionally result in language
mixing and a slight decrease in model performance. Adequate Output Length: We
recommend using an output length of 32,768 tokens for most queries. For
benchmarking on highly complex problems, such as those found in math and
programming competitions, we suggest setting the max output length to 81,920
tokens. This provides the model with sufficient space to generate detailed and
comprehensive responses, thereby enhancing its overall performance.

Standardize Output Format: We recommend using prompts to standardize model
outputs when benchmarking.

Math Problems: Include "Please reason step by step, and put your final answer
within \boxed{}." in the prompt. Multiple-Choice Questions: Add the following
JSON structure to the prompt to standardize responses: "Please show your choice
in the answer field with only the choice letter, e.g., "answer": "C"." Long
Video Understanding: To optimize inference efficiency for plain text and images,
the size parameter in the released video_preprocessor_config.json is
conservatively configured. It is recommended to set the longest_edge parameter
in the video_preprocessor_config file to 469,762,048 (corresponding to 224k
video tokens) to enable higher frame-rate sampling for hour-scale videos and
thereby achieve superior performance. For example,

{"longest_edge": 469762048, "shortest_edge": 4096}

Alternatively, override the default values via engine startup parameters. For
implementation details, refer to: vLLM / SGLang.

---

---

I'd stop hardcoding feature additions

Right now your launch logic is growing like

if (fa) ...

if (cache)

...

if (rpc)

...

if (mtp)

...

if (...)

I'd instead do something like

const launchFlags = []

launchFlags.push(...)

launchFlags.push(...)

or even

function addFlag(flag, value)

because llama.cpp is adding options almost weekly now.

---

we need to be recording which model had which convo on the saved chats on the
left. and when we expand them, they need to be truncated, not showing the full
body.

---

stuff that's still broken:

- still have nothing from worker in telemetry, though I see 0 instead of -- for
  its gpu values?
- the prefill/think/answer bar still isn't filling up visually in response to
  the logs,
- and it is still a flat bar, instead of a graph showing time on x axis and
  token/s on y axis.

---

- csv should record launch command
- eventually csv viewer should have csv entries on the left and graphs on the
  right.
-
