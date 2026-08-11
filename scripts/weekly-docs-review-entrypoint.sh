#!/bin/sh
set -eu

repo_uid="${REPO_UID:-1000}"
repo_gid="${REPO_GID:-1000}"
runtime_home="/tmp/weekly-docs-review-home"
source_codex_dir="/scheduler-auth/codex"
source_key="/scheduler-auth/id_ed25519"
source_known_hosts="/scheduler-auth/known_hosts"

case "$repo_uid:$repo_gid" in
  *[!0-9:]*|:*|*:)
    echo "REPO_UID and REPO_GID must be numeric" >&2
    exit 1
    ;;
esac
if [ "$repo_uid" -eq 0 ] || [ "$repo_gid" -eq 0 ]; then
  echo "REPO_UID and REPO_GID must identify a non-root repository owner" >&2
  exit 1
fi

if [ ! -s "$source_codex_dir/auth.json" ]; then
  echo "Codex auth volume is missing auth.json; authenticate claude-bridge first" >&2
  exit 1
fi
if [ ! -f "$source_key" ] || [ ! -s "$source_key" ]; then
  echo "WEEKLY_DOCS_REVIEW_SSH_KEY must point to a readable private deploy key" >&2
  exit 1
fi
if [ ! -f "$source_known_hosts" ] || [ ! -s "$source_known_hosts" ]; then
  echo "WEEKLY_DOCS_REVIEW_KNOWN_HOSTS must point to a trusted known_hosts file" >&2
  exit 1
fi

install -d -m 700 -o "$repo_uid" -g "$repo_gid" \
  "$runtime_home" "$runtime_home/.codex" "$runtime_home/.ssh"
cp -R "$source_codex_dir/." "$runtime_home/.codex/"
install -m 600 -o "$repo_uid" -g "$repo_gid" \
  "$source_key" "$runtime_home/.ssh/id_ed25519"
install -m 600 -o "$repo_uid" -g "$repo_gid" \
  "$source_known_hosts" "$runtime_home/.ssh/known_hosts"
chown -R "$repo_uid:$repo_gid" "$runtime_home/.codex"

run_as_repo_user() {
  setpriv --reuid "$repo_uid" --regid "$repo_gid" --clear-groups \
    env HOME="$runtime_home" \
      CODEX_HOME="$runtime_home/.codex" \
      GIT_SSH_COMMAND="ssh -i $runtime_home/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$runtime_home/.ssh/known_hosts" \
      "$@"
}

run_as_repo_user git config --global --add safe.directory /workspace
exec setpriv --reuid "$repo_uid" --regid "$repo_gid" --clear-groups \
  env HOME="$runtime_home" \
    CODEX_HOME="$runtime_home/.codex" \
    GIT_SSH_COMMAND="ssh -i $runtime_home/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$runtime_home/.ssh/known_hosts" \
    "$@"
