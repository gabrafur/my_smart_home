#!/bin/sh
# Run a command as the public CI sees this repository: without the components installed
# on the Raspberry (/usr/local/lib/raspberry-*, /etc/raspberry-*). On 17/11 local
# validation passed only because such a file existed here, while GitHub Actions stayed red.
# Debian's global Node modules (/usr/share/nodejs) cannot be hidden, because Debian's node
# and npm load their own code from there; scripts/ci-parity-node-preload.cjs removes them
# from module lookup in every other Node process (NODE_OPTIONS), as on a CI runner.
#
# The folders are hidden by empty read-only tmpfs mounts in a private mount namespace,
# visible only to this command. Nothing on the host changes and the command runs with the
# caller's uid, gid and groups. Needs passwordless sudo for unshare.
#
# Usage: scripts/ci-parity-run.sh [command...]   (default: make validate-public)
set -eu

[ "${CI_PARITY_INSIDE:-}" != 1 ] || { echo "ci-parity: already inside the parity namespace" >&2; exit 64; }
[ "$#" -gt 0 ] || set -- make --no-print-directory validate-public

uid=$(id -u)
gid=$(id -g)
masks=""
for path in /usr/local/lib/raspberry-* /etc/raspberry-*; do
  [ -d "$path" ] && [ ! -L "$path" ] || continue
  masks="$masks $path"
done

preload="$(cd "$(dirname "$0")" && pwd)/ci-parity-node-preload.cjs"
[ -r "$preload" ] || { echo "ci-parity: missing $preload" >&2; exit 66; }
export CI_PARITY_INSIDE=1 CI_PARITY_MASKS="$masks"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$preload"
# A private mount namespace created through sudo, then back to the caller's uid, gid and
# groups before the command runs. (An unprivileged user namespace would show root-owned
# files as "nobody" and break ownership checks that CI does not break.)
exec sudo -n --preserve-env=HOME,PATH,CI_PARITY_INSIDE,CI_PARITY_MASKS,TMPDIR,LANG,NODE_OPTIONS \
  unshare --mount --propagation private sh -c '
  set -eu
  for path in $CI_PARITY_MASKS; do mount -t tmpfs -o ro,size=4k ci-parity "$path"; done
  echo "ci-parity: hidden $(echo $CI_PARITY_MASKS | wc -w) host-only folder(s)" >&2
  uid=$1 gid=$2; shift 2
  exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
' ci-parity "$uid" "$gid" "$@"
