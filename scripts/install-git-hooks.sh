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

# Git opens the SSH connection before pre-push runs the full validation (several
# minutes on a Raspberry Pi). Without keepalive the remote drops the idle
# session and the push ends with SIGPIPE even though validation passed. Only
# warn: SSH settings belong to the user.
origin_url=$(git -C "$repository_root" remote get-url --push origin 2>/dev/null || true)
ssh_host=$(printf '%s\n' "$origin_url" | sed -n \
  -e 's#^ssh://\([^@/]*@\)\{0,1\}\([^:/]*\).*#\2#p' \
  -e 's#^[^@/:]*@\([^:/]*\):.*#\1#p')
if [ -n "$ssh_host" ]; then
  ssh_command="${GIT_SSH_COMMAND:-$(git -C "$repository_root" config --get core.sshCommand || true)}"
  keepalive=no
  case "$ssh_command" in *ServerAliveInterval*) keepalive=yes ;; esac
  if [ "$keepalive" = no ] && command -v ssh >/dev/null 2>&1; then
    interval=$(ssh -G ${INSTALL_GIT_HOOKS_SSH_CONFIG:+-F "$INSTALL_GIT_HOOKS_SSH_CONFIG"} "$ssh_host" 2>/dev/null \
      | sed -n 's/^serveraliveinterval //p')
    [ -n "$interval" ] && [ "$interval" != 0 ] && keepalive=yes
  fi
  if [ "$keepalive" = no ]; then
    printf 'install-git-hooks: warning: SSH to %s has no keepalive; a long pre-push can make the remote drop the push.\n' "$ssh_host" >&2
    printf "Add ServerAliveInterval to ~/.ssh/config for that host, or run:\n  git config core.sshCommand 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10'\n" >&2
  fi
fi
