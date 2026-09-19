#!/bin/sh
set -eu

npm_bin="${CODEX_CLI_NPM_BIN:-/usr/bin/npm}"
user_lookup_bin="${CODEX_CLI_USER_LOOKUP_BIN:-/usr/bin/getent}"
package="@openai/codex"

[ -x "$npm_bin" ] || {
  echo "codex-cli-update status=failed failure_stage=npm-unavailable"
  exit 66
}

if [ -n "${CODEX_CLI_PREFIX:-}" ]; then
  codex_prefix=$CODEX_CLI_PREFIX
else
  [ -x "$user_lookup_bin" ] || {
    echo "codex-cli-update status=failed failure_stage=user-home-unavailable"
    exit 66
  }
  codex_user_home=$($user_lookup_bin passwd "$(id -u)" | awk -F: 'NR == 1 { print $6 }')
  [ -n "$codex_user_home" ] || {
    echo "codex-cli-update status=failed failure_stage=user-home-unavailable"
    exit 66
  }
  codex_prefix="$codex_user_home/.local"
fi

case "$codex_prefix" in
  /*) ;;
  *) echo "codex-cli-update status=failed failure_stage=prefix-invalid"; exit 64 ;;
esac
[ "$(basename -- "$codex_prefix")" = ".local" ] || {
  echo "codex-cli-update status=failed failure_stage=prefix-invalid"
  exit 64
}

codex_bin="${CODEX_CLI_BIN:-$codex_prefix/bin/codex}"
case "$codex_bin" in
  /*) ;;
  *) echo "codex-cli-update status=failed failure_stage=binary-invalid"; exit 64 ;;
esac

read_version() {
  "$1" --version 2>/dev/null | sed -n 's/^codex-cli \([0-9][0-9A-Za-z.-]*\)$/\1/p' | sed -n '1p'
}

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$'
}

current_version=""
if [ -x "$codex_bin" ]; then
  current_version=$(read_version "$codex_bin")
fi
[ -z "$current_version" ] || valid_version "$current_version" || {
  echo "codex-cli-update status=failed failure_stage=current-version-invalid"
  exit 65
}

set +e
latest_version=$($npm_bin view "$package" version --loglevel=error 2>/dev/null)
lookup_status=$?
set -e
latest_version=$(printf '%s\n' "$latest_version" | sed -n '1p')
if [ "$lookup_status" -ne 0 ] || ! valid_version "$latest_version"; then
  echo "codex-cli-update status=failed failure_stage=registry-lookup"
  exit 69
fi

if [ "$current_version" = "$latest_version" ]; then
  echo "codex-cli-update status=success action=current from=$current_version to=$latest_version"
  exit 0
fi

rollback() {
  [ -n "$current_version" ] || return 0
  "$npm_bin" install --global --prefix "$codex_prefix" "$package@$current_version" --no-audit --no-fund --loglevel=error >&2 || return 0
}

set +e
"$npm_bin" install --global --prefix "$codex_prefix" "$package@$latest_version" --no-audit --no-fund --loglevel=error >&2
install_status=$?
set -e
if [ "$install_status" -ne 0 ]; then
  rollback
  echo "codex-cli-update status=failed failure_stage=install from=${current_version:-missing} target=$latest_version"
  exit "$install_status"
fi

installed_version=""
if [ -x "$codex_bin" ]; then
  installed_version=$(read_version "$codex_bin")
fi
if [ "$installed_version" != "$latest_version" ]; then
  rollback
  echo "codex-cli-update status=failed failure_stage=verify from=${current_version:-missing} target=$latest_version"
  exit 70
fi

echo "codex-cli-update status=success action=updated from=${current_version:-missing} to=$installed_version"
