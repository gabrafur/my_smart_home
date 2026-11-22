"""Resolve the Raspberry host operator account and render installer templates.

`host_operator` is the logical role of the unprivileged Linux account that owns
the Codex app-server, its control socket and the repository checkout. Tracked
sources never name that account: units and fixed paths carry the placeholders
below and a Root operator renders them at install time from configuration.

Resolution order (first match wins, no hard-coded fallback):
  1. an explicit account name passed by the operator (``--operator-user``);
  2. ``RASPBERRY_HOST_OPERATOR`` in the operator's environment;
  3. ``SUDO_USER`` when the operator was started through sudo.
The account must exist, must not be root and must have an absolute home.
"""
import grp
import os
import pwd
import re

USER = '@HOST_OPERATOR_USER@'
GROUP = '@HOST_OPERATOR_GROUP@'
HOME = '@HOST_OPERATOR_HOME@'
PLACEHOLDER = re.compile(rb'@HOST_OPERATOR_[A-Z_]+@')
NAME = re.compile(r'[a-z_][a-z0-9_-]{0,31}\Z')
SAFE_HOME = re.compile(r'/[A-Za-z0-9._/-]{1,255}\Z')


class OperatorUnresolved(ValueError):
    pass


def resolve(explicit=None, environ=None, getpwnam=pwd.getpwnam, getgrgid=grp.getgrgid):
    environ = os.environ if environ is None else environ
    name = explicit or environ.get('RASPBERRY_HOST_OPERATOR') or environ.get('SUDO_USER')
    if not name or not NAME.fullmatch(name) or name == 'root':
        raise OperatorUnresolved('host_operator_unresolved')
    try:
        entry = getpwnam(name)
        group = getgrgid(entry.pw_gid).gr_name
    except KeyError:
        raise OperatorUnresolved('host_operator_unknown_account') from None
    home = entry.pw_dir.rstrip('/')
    if entry.pw_uid == 0 or not SAFE_HOME.fullmatch(home) or '/../' in home + '/' or not NAME.fullmatch(group):
        raise OperatorUnresolved('host_operator_account_refused')
    return {'user': name, 'group': group, 'home': home, 'uid': entry.pw_uid, 'gid': entry.pw_gid}


def render(template, operator):
    """Template bytes -> installed bytes. Refuses unknown or leftover placeholders."""
    body = (template.replace(USER.encode(), operator['user'].encode())
            .replace(GROUP.encode(), operator['group'].encode())
            .replace(HOME.encode(), operator['home'].encode()))
    if PLACEHOLDER.search(body):
        raise OperatorUnresolved('host_operator_placeholder_unknown')
    return body
