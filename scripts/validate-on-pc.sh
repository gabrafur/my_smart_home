#!/usr/bin/env bash
# Run the repository validation on the owner's PC (WSL) instead of the loaded Raspberry.
#
# Why: on 20/11/2026 timing-sensitive tests failed under the Pi's own load (load average 6-8
# during validate-public) and refused three publications although they pass alone. The PC has
# 12 cores and no Raspberry components, which is also closer to the public CI runner.
#
# What it does: sends `git archive HEAD` (tracked files only; no .local-secrets, no .env) to a
# fresh folder in WSL, makes it a throwaway git repository (some checks use `git ls-files`),
# and runs `make -k <target>` with Node 20 and Python 3.13 from ~/ci-parity (installed in user
# space, nothing system-wide). It validates the COMMIT, not uncommitted edits.
#
# Tests that hard-code the Pi's uid 1001 cannot pass in WSL (uid 1000, no sudo). They are listed
# in scripts/validate-on-pc.pi-only.txt; when they are the ONLY failures the run is reported as
# passed with a note, and they must still pass on the Pi and in the public CI.
#
# Usage: scripts/validate-on-pc.sh [make-target]      (default: validate-public)
# Exit:  0 passed, 1 failed on the PC, 3 PC unavailable (fall back to the Pi, say so).
# Env:   VALIDATION_PC (default pc-gabriel, an SSH host reaching the Windows OpenSSH).
set -u
target=${1:-validate-public}
host=${VALIDATION_PC:-pc-gabriel}
ssh_opts="-o BatchMode=yes -o ConnectTimeout=6 -o ServerAliveInterval=20"
cd "$(git rev-parse --show-toplevel)" || exit 2
log=$(mktemp) && trap 'rm -f "$log"' EXIT

# shellcheck disable=SC2086
if ! ssh $ssh_opts "$host" "wsl.exe -e true" >/dev/null 2>&1; then
  echo "validate-on-pc: PC unavailable ($host); run the validation on the Pi and say so." >&2
  exit 3
fi

rev=$(git rev-parse --short HEAD)
subject_b64=$(git log -1 --format=%s | base64 -w0)
echo "validate-on-pc: sending HEAD $rev and running make -k $target on $host"
# shellcheck disable=SC2086
git archive --format=tar HEAD | ssh $ssh_opts "$host" \
  'wsl.exe -e bash -c "rm -rf ~/ci-parity/work && mkdir -p ~/ci-parity/work && tar -x -C ~/ci-parity/work"' || exit 3

# shellcheck disable=SC2086
ssh $ssh_opts "$host" 'wsl.exe -e bash -s' 2>&1 <<REMOTE | tee "$log"
set -u
cd ~/ci-parity/work || exit 3
export PATH="\$HOME/ci-parity/node/bin:\$HOME/ci-parity/python/cpython-3.13-linux-x86_64-gnu/bin:\$PATH"
git init -q && git add -A && git -c user.name=ci -c user.email=ci@example.invalid commit -qm "\$(echo $subject_b64 | base64 -d)"
echo "node \$(node -v), \$(python3 -V), \$(nproc) cores, load \$(cut -d' ' -f1 /proc/loadavg)"
make -k --no-print-directory $target
REMOTE
status=${PIPESTATUS[0]}

if [ "$status" -eq 0 ]; then
  echo "validate-on-pc: $target passed for $rev"
  exit 0
fi

# Failed: decide whether every failure is a listed Pi-only test.
allow=scripts/validate-on-pc.pi-only.txt
failing=$(grep '^not ok' "$log" | sed 's/^not ok [0-9]* - //')
failed_targets=$(grep -o 'Makefile:[0-9]*: [a-z-]*\] Error' "$log" | sed 's/.*: \(.*\)\] Error/\1/' | sort -u | grep -v "^$target\$")
others=$(printf '%s\n' "$failed_targets" | grep -v '^validate-scripts$' | grep -v '^$')
unlisted=""
# Collect failing titles that match no listed substring.
while IFS= read -r title; do
  [ -z "$title" ] && continue
  hit=no
  while IFS= read -r known; do
    case "$known" in ''|'#'*) continue;; esac
    case "$title" in *"$known"*) hit=yes; break;; esac
  done < "$allow"
  [ "$hit" = no ] && unlisted="$unlisted
  - $title"
done <<TITLES
$failing
TITLES

if [ -z "$unlisted" ] && [ -z "$others" ] && [ -n "$failing" ]; then
  count=$(printf '%s\n' "$failing" | grep -c .)
  echo "validate-on-pc: $target passed for $rev except $count Pi-only test(s) (uid 1001); they must pass on the Pi and in the public CI."
  exit 0
fi
echo "validate-on-pc: $target FAILED for $rev (exit $status)" >&2
[ -n "$unlisted" ] && printf 'validate-on-pc: failing tests not on the Pi-only list:%s\n' "$unlisted" >&2
[ -n "$others" ] && printf 'validate-on-pc: failed make targets besides validate-scripts:\n%s\n' "$others" >&2
exit 1
