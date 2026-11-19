"""Owner administration for the OAuth edge. Run as root from the installed copy.

  configure <https-url>   store the public Funnel URL (no trailing slash)
  set-owner               choose the passphrase; prints the authenticator secret once
  revoke-all              forget every client and token, then restart the edge

Secrets are read from a TTY or generated here and shown only on this terminal. They are
never taken from arguments, the environment, the chat or Git.
"""
import base64
import getpass
import hashlib
import json
import os
import pwd
import re
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

STATE = Path('/var/lib/raspberry-mcp-edge')
ACCOUNT = 'raspberry-mcp-edge'


def write(path, value, mode=0o440):
    account = pwd.getpwnam(ACCOUNT)
    tmp = path.with_name(path.name + '.new')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out)
    os.chown(tmp, 0, account.pw_gid)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def configure(url):
    if re.fullmatch(r'https://[a-z0-9.-]+\.ts\.net', url) is None:
        raise SystemExit('public_url_must_be_a_ts_net_https_origin')
    write(STATE / 'config.json', {'public_base_url': url})
    print('configured')


def set_owner():
    if not sys.stdin.isatty():
        raise SystemExit('interactive_terminal_required')
    passphrase = getpass.getpass('Passphrase (min 16 chars): ')
    if len(passphrase) < 16 or passphrase != getpass.getpass('Repeat: '):
        raise SystemExit('passphrase_too_short_or_different')
    salt = secrets.token_bytes(16)
    secret = base64.b32encode(secrets.token_bytes(20)).decode()
    digest = hashlib.scrypt(passphrase.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    write(STATE / 'owner.json', {'salt': salt.hex(), 'hash': digest.hex(), 'totp': secret})
    print('Add this to your authenticator app (shown once):')
    print('otpauth://totp/Raspberry%20MCP?secret=' + secret + '&issuer=' + quote('Raspberry MCP'))
    print('Manual key:', secret)


def revoke_all():
    store = STATE / 'state' / 'store.json'
    if store.exists():
        store.unlink()
    subprocess.run(['/usr/bin/systemctl', 'restart', 'raspberry-mcp-edge.service'], check=True)
    print('revoked')


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('root_required')
    action = sys.argv[1:2]
    if action == ['configure'] and len(sys.argv) == 3:
        configure(sys.argv[2])
    elif action == ['set-owner'] and len(sys.argv) == 2:
        set_owner()
    elif action == ['revoke-all'] and len(sys.argv) == 2:
        revoke_all()
    else:
        raise SystemExit(__doc__)
