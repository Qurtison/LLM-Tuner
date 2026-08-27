# Tooling

- LLM-Tuner repo (/home/james/projects/LLM-Tuner) is bun-based: verify with `bun run typecheck`, `bun test`, and `bun run build` (Vite). Confidence: 0.85
- At the LLM-Tuner root, bare `bun test` (and `bun test tests/`) also sweeps the vendored `llama.cpp/tools/ui` submodule suite — 67 pre-existing failures from `$lib/...` module resolution, unrelated to the app. Scope repo tests with `cd tests && bun test .`. Confidence: 0.85
