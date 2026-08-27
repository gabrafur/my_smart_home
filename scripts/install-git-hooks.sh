#!/usr/bin/env sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(git -C "$script_directory/.." rev-parse --show-toplevel)
configured_path=$(git -C "$repository_root" config --local --get core.hooksPath || true)

if [ -n "$configured_path" ] && [ "$configured_path" != ".githooks" ]; then
  printf 'install-git-hooks: refusing to replace core.hooksPath=%s\n' "$configured_path" >&2
  printf 'Integrate .githooks/commit-msg and .githooks/pre-push with the existing hooks manually.\n' >&2
  exit 1
fi

git -C "$repository_root" config --local core.hooksPath .githooks
printf 'Git hooks enabled for this checkout: commit-msg and pre-push\n'
