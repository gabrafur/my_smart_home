#!/usr/bin/env bash
set -Eeuo pipefail

MODE="dry-run"
ACTION="enable"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)
RUNTIME_PATHS=(
  .agents
  .codex
  .githooks
  appdaemon
  bindings
  bootstrap
  docs
  homeassistant
  ia-bridge
  modules
  mosquitto
  nodered
  restore
  scripts
  templates
  tools
  zigbee2mqtt
)

usage() {
  cat <<'EOF'
Usage: bootstrap/configure-raspberry-checkout.sh [--dry-run|--apply|--disable]

Configures an idempotent cone-mode sparse checkout for the Raspberry Pi.
The default is a read-only plan. --apply refuses a dirty working tree.
--disable restores the full working tree without changing Git history.

A sparse checkout removes tracked files only. Ignored runtime databases,
backups, secrets and bind-mount data are preserved. To avoid downloading
unneeded historical blobs, create a fresh clone with --filter=blob:none;
turning sparse checkout on in a full clone does not shrink existing .git data.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --disable) MODE="apply"; ACTION="disable" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
  shift
done

[[ -n "$REPO_ROOT" && "$REPO_ROOT" != / ]] || {
  echo "Repository root is unavailable or unsafe" >&2
  exit 66
}
[[ ! -L "$REPO_ROOT" ]] || {
  echo "Repository root must not be a symlink" >&2
  exit 65
}

if [[ "$MODE" == dry-run ]]; then
  printf 'mode=dry-run action=%s repository=%s\n' "$ACTION" "$REPO_ROOT"
  if [[ "$ACTION" == enable ]]; then
    printf 'runtime_path=%s\n' "${RUNTIME_PATHS[@]}"
  fi
  printf 'partial_clone=%s\n' "$(git -C "$REPO_ROOT" config --bool remote.origin.promisor || printf false)"
  printf 'partial_clone_filter=%s\n' "$(git -C "$REPO_ROOT" config --get remote.origin.partialclonefilter || printf none)"
  exit 0
fi

if [[ -n $(git -C "$REPO_ROOT" status --porcelain=v1) ]]; then
  echo "Refusing to change sparse checkout with a dirty working tree" >&2
  exit 75
fi

if [[ "$ACTION" == disable ]]; then
  git -C "$REPO_ROOT" sparse-checkout disable
  echo "Sparse checkout disabled"
  exit 0
fi

git -C "$REPO_ROOT" sparse-checkout init --cone
git -C "$REPO_ROOT" sparse-checkout set --cone "${RUNTIME_PATHS[@]}"
git -C "$REPO_ROOT" sparse-checkout reapply

echo "Sparse checkout configured for the Raspberry Pi runtime"
if [[ $(git -C "$REPO_ROOT" config --bool remote.origin.promisor || printf false) != true ]]; then
  echo "Notice: this existing clone is not partial; .git will not shrink without a separately validated replacement clone"
fi
