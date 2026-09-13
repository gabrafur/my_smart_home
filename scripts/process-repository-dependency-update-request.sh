#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$script_dir")
trigger_dir="${DAILY_UPDATE_TRIGGER_DIR:-$repo_root/homeassistant/.daily-update-trigger}"
resource_safe="${REPOSITORY_DEPENDENCY_RESOURCE_SAFE_SCRIPT:-$script_dir/run-resource-safe.sh}"
update_script="${REPOSITORY_DEPENDENCY_UPDATE_SCRIPT:-$script_dir/update-repository-dependency.mjs}"
node_bin="${REPOSITORY_DEPENDENCY_NODE_BIN:-/usr/bin/node}"
request_file="$trigger_dir/repository-dependency-requested"
processing_file="$trigger_dir/repository-dependency-processing"
result_file="$trigger_dir/repository-dependency-result"

case "$trigger_dir" in
  /*) ;;
  *) echo "DAILY_UPDATE_TRIGGER_DIR must be absolute" >&2; exit 64 ;;
esac
[ -x "$resource_safe" ] || { echo "Resource-safe runner is unavailable: $resource_safe" >&2; exit 66; }
[ -r "$update_script" ] || { echo "Repository dependency updater is unavailable: $update_script" >&2; exit 66; }
case "$node_bin" in
  /*) ;;
  *) echo "REPOSITORY_DEPENDENCY_NODE_BIN must be absolute" >&2; exit 64 ;;
esac
[ -x "$node_bin" ] || { echo "Node.js runtime is unavailable: $node_bin" >&2; exit 66; }
mkdir -p "$trigger_dir"

if [ ! -f "$processing_file" ]; then
  [ -f "$request_file" ] || exit 0
  mv "$request_file" "$processing_file" 2>/dev/null || exit 0
fi

request_id=$(sed -n '1p' "$processing_file" | tr -cd 'A-Za-z0-9_.:-')
package=$(sed -n '2p' "$processing_file" | tr -cd 'a-z0-9._-')
[ -n "$request_id" ] || request_id=invalid
printf '%s' "$package" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,79}$' || package=invalid
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

publish_result() {
  temporary="$trigger_dir/repository-dependency-result.$$"
  umask 007
  printf '%s\n' "$1" > "$temporary"
  mv "$temporary" "$result_file"
}

restore_request() {
  if [ -f "$processing_file" ]; then
    rm -f -- "$request_file"
    mv "$processing_file" "$request_file"
  fi
  publish_result "repository-dependency-update package=$package status=deferred request_id=$request_id started_at=$started_at finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
trap 'restore_request; exit 75' HUP INT TERM

if [ "$package" = invalid ]; then
  rm -f -- "$processing_file"
  publish_result "repository-dependency-update package=invalid status=failed request_id=$request_id reason=invalid-package"
  trap - HUP INT TERM
  exit 64
fi

publish_result "repository-dependency-update package=$package status=running request_id=$request_id started_at=$started_at"
output_file=$(mktemp)
cleanup() { rm -f -- "$output_file"; }
trap 'cleanup; restore_request; exit 75' HUP INT TERM
set +e
"$resource_safe" "$node_bin" "$update_script" --package "$package" > "$output_file" 2>&1
status=$?
set -e
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$status" -eq 75 ]; then
  cleanup
  restore_request
  trap - HUP INT TERM
  exit 75
fi

detail=$(sed -n 's/^repository-dependency-update / /p' "$output_file" | tail -n 1 | tr -cd 'A-Za-z0-9_.:= -')
rm -f -- "$processing_file"
trap - HUP INT TERM
cleanup
if [ "$status" -eq 0 ]; then
  publish_result "repository-dependency-update package=$package status=success request_id=$request_id started_at=$started_at finished_at=$finished_at$detail"
  exit 0
fi

publish_result "repository-dependency-update package=$package status=failed request_id=$request_id started_at=$started_at finished_at=$finished_at exit_code=$status$detail"
exit "$status"
