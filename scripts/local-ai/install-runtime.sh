#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --target /absolute/path/codex-local-ai/current" >&2
  exit 2
}

[[ ${1:-} == "--target" && -n ${2:-} && $# -eq 2 ]] || usage
runtime_target=$2
[[ $runtime_target == /* && $runtime_target == */codex-local-ai/current ]] || usage

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_parent=$(dirname -- "$runtime_target")
[[ -d $runtime_target && -d $runtime_parent ]] || {
  echo "runtime target is not an existing installation" >&2
  exit 1
}

runtime_group=$(stat -c '%G' "$runtime_target")
runtime_stamp=$(date -u +%Y%m%dT%H%M%SZ)
runtime_backup="$runtime_parent/previous-structured-canary-$runtime_stamp"
runtime_stage=$(mktemp -d "$runtime_parent/.current-structured-canary.XXXXXX")
chmod 0750 "$runtime_stage"

install -d -m 0750 "$runtime_stage/prompts"
for runtime_file in \
  local-ai local-ai.py local-ai.sh memory_context.py routing.py telemetry.py log_facts.py \
  model_registry.py model-registry.json restricted_runtime.py canary_state.py \
  structured_canary.py mcp_server.py recover-endpoint.mjs VERSION; do
  install -m 0640 "$script_dir/$runtime_file" "$runtime_stage/$runtime_file"
done
chmod 0750 "$runtime_stage/local-ai" "$runtime_stage/local-ai.py" "$runtime_stage/local-ai.sh" \
  "$runtime_stage/structured_canary.py" "$runtime_stage/mcp_server.py" "$runtime_stage/recover-endpoint.mjs"
install -m 0640 "$runtime_target/local-ai-preflight.mjs" "$runtime_stage/local-ai-preflight.mjs"
chmod 0750 "$runtime_stage/local-ai-preflight.mjs"
for prompt in "$script_dir"/prompts/*.md; do
  install -m 0640 "$prompt" "$runtime_stage/prompts/$(basename -- "$prompt")"
done
chgrp -R "$runtime_group" "$runtime_stage"

mv -- "$runtime_target" "$runtime_backup"
if ! mv -- "$runtime_stage" "$runtime_target"; then
  mv -- "$runtime_backup" "$runtime_target"
  echo "runtime install failed; previous runtime restored" >&2
  exit 1
fi

echo "installed structured canary runtime; previous runtime preserved"
