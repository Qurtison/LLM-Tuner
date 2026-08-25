#!/usr/bin/env bash
# Host-native deploy steps for LLM-Tuner (no Docker). Invoked by the pipeline's
# deploy.sh after its git fetch/reset, or by hand after a manual pull.
#
# Installs deps, rebuilds the frontend bundle, restarts the llm-tuner systemd
# user unit. May run as root (webhook receiver) or as the owning user; the
# build always executes as the directory owner so artifacts never end up
# root-owned.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_NAME="llm-tuner"
TARGET_USER="$(stat -c '%U' "$APP_DIR")"
TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
BUN="${TARGET_HOME}/.bun/bin/bun"
if [[ ! -x "${BUN}" ]]; then
  BUN="$(command -v bun || true)"
fi
if [[ -z "${BUN}" ]]; then
  echo "error: bun not found for user ${TARGET_USER}" >&2
  exit 1
fi

run_as_owner() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u "${TARGET_USER}" -- env \
      HOME="${TARGET_HOME}" \
      XDG_RUNTIME_DIR="/run/user/${TARGET_UID}" \
      "$@"
  else
    env XDG_RUNTIME_DIR="/run/user/$(id -u)" "$@"
  fi
}

echo "[llm-tuner] bun install"
run_as_owner "${BUN}" --cwd "${APP_DIR}" install --frozen-lockfile

echo "[llm-tuner] vite build"
run_as_owner "${BUN}" --cwd "${APP_DIR}" run build

echo "[llm-tuner] restart ${UNIT_NAME}"
run_as_owner systemctl --user restart "${UNIT_NAME}"

echo "[llm-tuner] done"
