// Isolated ESLint config — see tools/lint/package.json for why this toolchain
// lives in its own node_modules (pinned to typescript@5) instead of the root.
// Invoked via `bun run lint` / `bun run lint:fix` from the repo root — patterns
// below are relative to that cwd, not to this file's location.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "tools/**",
      "llama.cpp/**",
      "llama-cli/**",
      "old_docs/**",
      "presets/**",
      "config/**",
      "logs/**",
      "__pycache__/**",
      "design_handoff_preset_inspector/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/client/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Only the classic hook-correctness rules for now — v7's "recommended"
      // also bundles the newer React Compiler-derived rules (set-state-in-effect,
      // refs, purity, etc.) as hard errors, which flag a lot of pre-existing
      // patterns in this codebase. Revisit once those are worth adopting.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["src/server/**/*.ts", "scripts/**/*.ts", "*.config.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, Bun: "readonly" },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
