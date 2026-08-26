#!/usr/bin/env bash
set -euo pipefail

project_root=$(git rev-parse --show-toplevel)
extension_roots=(
  "${VSCODE_EXTENSIONS_DIR:-}"
  "${HOME}/.vscode-server/extensions"
  "${HOME}/.vscode/extensions"
)
candidates=()

for extension_root in "${extension_roots[@]}"; do
  [[ -n "${extension_root}" && -d "${extension_root}" ]] || continue
  while IFS= read -r candidate; do
    candidates+=("${candidate}")
  done < <(
    find "${extension_root}" -type f \
      -path '*/openai.chatgpt-*-linux-*/bin/linux-*/codex' -print 2>/dev/null
  )
done

if (( ${#candidates[@]} == 0 )); then
  echo "Codex bundled with the VS Code extension was not found for this user." >&2
  exit 1
fi

codex_bin=$(printf '%s\n' "${candidates[@]}" | sort -V | tail -n 1)
echo "Opening hook review with: ${codex_bin}" >&2
echo "Run /hooks, confirm PostToolUse is 1/1, then exit and reload the VS Code window." >&2
exec "${codex_bin}" --no-alt-screen -C "${project_root}"
