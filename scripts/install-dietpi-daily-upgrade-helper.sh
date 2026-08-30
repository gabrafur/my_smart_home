#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run this installer with sudo" >&2; exit 77; }
[ -n "${SUDO_USER:-}" ] || { echo "SUDO_USER is required" >&2; exit 64; }
case "$SUDO_USER" in
  *[!A-Za-z0-9_.-]*|'') echo "SUDO_USER contains unsupported characters" >&2; exit 64 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_helper="$script_dir/dietpi-daily-upgrade.sh"
installed_helper="/usr/local/sbin/smart-home-dietpi-daily-upgrade"
sudoers_file="/etc/sudoers.d/smart-home-dietpi-daily-upgrade"
temporary=$(mktemp)
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

[ -x "$source_helper" ] || { echo "Versioned DietPi helper is unavailable" >&2; exit 66; }
command -v visudo >/dev/null 2>&1 || { echo "visudo is required" >&2; exit 69; }

printf '%s ALL=(root) NOPASSWD: %s\n' "$SUDO_USER" "$installed_helper" > "$temporary"
chmod 0440 "$temporary"
visudo -cf "$temporary" >/dev/null
install -o root -g root -m 0755 "$source_helper" "$installed_helper"
install -o root -g root -m 0440 "$temporary" "$sudoers_file"
visudo -cf "$sudoers_file" >/dev/null
echo "Installed root-owned DietPi updater and restricted sudo rule for $SUDO_USER"
