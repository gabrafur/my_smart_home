#!/bin/sh
set -eu

repo_uid="${REPO_UID:-1000}"
repo_gid="${REPO_GID:-1000}"
node_red_uid="${NODE_RED_UID:-1000}"
runtime_home="/tmp/kia-uvo-codex-merge-home"
source_codex_dir="/worker-auth/codex"
source_key="/worker-auth/id_ed25519"
source_known_hosts="/worker-auth/known_hosts"
status_dir="/run/kia-uvo-merge"
trigger_dir="/run/kia-uvo-merge-trigger"

case "$repo_uid:$repo_gid:$node_red_uid" in *[!0-9:]*|:*|*:) echo "REPO_UID, REPO_GID and NODE_RED_UID must be numeric" >&2; exit 1 ;; esac
[ "$repo_uid" -ne 0 ] && [ "$repo_gid" -ne 0 ] || { echo "repository owner must be non-root" >&2; exit 1; }
[ -s "$source_codex_dir/auth.json" ] || { echo "Codex auth volume is missing auth.json" >&2; exit 1; }
[ -s "$source_key" ] || { echo "Kia UVO merge SSH key is unavailable" >&2; exit 1; }
[ -s "$source_known_hosts" ] || { echo "Kia UVO merge known_hosts is unavailable" >&2; exit 1; }

getent group "$repo_gid" >/dev/null || groupadd --gid "$repo_gid" kia-uvo-merge-runtime
getent passwd "$repo_uid" >/dev/null || useradd --uid "$repo_uid" --gid "$repo_gid" \
  --home-dir "$runtime_home" --no-create-home --shell /usr/sbin/nologin kia-uvo-merge-runtime
install -d -m 700 -o "$repo_uid" -g "$repo_gid" "$runtime_home" "$runtime_home/.codex" "$runtime_home/.ssh"
install -d -m 755 -o "$repo_uid" -g "$repo_gid" "$status_dir"
install -d -m 2770 -o "$node_red_uid" -g "$repo_gid" "$trigger_dir"
cp -R "$source_codex_dir/." "$runtime_home/.codex/"
install -m 600 -o "$repo_uid" -g "$repo_gid" "$source_key" "$runtime_home/.ssh/id_ed25519"
install -m 600 -o "$repo_uid" -g "$repo_gid" "$source_known_hosts" "$runtime_home/.ssh/known_hosts"
chown -R "$repo_uid:$repo_gid" "$runtime_home/.codex"

exec setpriv --reuid "$repo_uid" --regid "$repo_gid" --clear-groups \
  env HOME="$runtime_home" CODEX_HOME="$runtime_home/.codex" \
  GIT_SSH_COMMAND="ssh -i $runtime_home/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$runtime_home/.ssh/known_hosts" \
  "$@"
