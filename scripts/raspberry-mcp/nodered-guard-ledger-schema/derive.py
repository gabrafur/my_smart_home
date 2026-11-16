"""Pure derivation that admits new task ledger tables in the sealed Node-RED administration guard.

The administration guard compares the exact table set of each ledger it
reads under shared locks. When the task store gains tables (the broad Eva
task profile added ``history_refs`` and ``profile_transitions``), every
preflight and apply fails closed with ``ledger_schema_tables_unknown``.
This derivation adds exactly the given table entries to ``SCHEMAS['task']``
and refreshes only the hashes that depend on the guard:

  guard source -> administration policy (pinned twice) -> administration unit

Selected columns, safe states, grants and every other field are unchanged.
The caller owns custody, compare-and-swap baselines and installation.
"""
import hashlib
import json
import re

NAMES = ('guard', 'admin_policy', 'admin_unit')
TABLE = re.compile(r'[a-z_]{1,40}\Z')
COLUMNS = re.compile(r'[a-z_0-9]{1,40}( [a-z_0-9]{1,40}){0,31}\Z')
ANCHOR = b"          'result_checkpoints': 'id result_hash terminal_state reply_available recorded'},\n"
HEAD = b" 'task': {'tasks': 'id task_key spec_hash"


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def swap(body, old, new, count, reason):
    need(body.count(old) == count and body.count(new) == 0, reason)
    return body.replace(old, new)


def derive(before, tables):
    need(type(before) is dict and set(before) == set(NAMES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in before.values()), 'three_fixed_inputs_required')
    need(type(tables) is dict and 0 < len(tables) <= 8 and all(
        type(k) is str and TABLE.match(k) and type(v) is str and COLUMNS.match(v) for k, v in tables.items()),
        'table_shape')
    guard = before['guard']
    need(guard.count(HEAD) == 1 and guard.count(ANCHOR) == 1 and guard.index(HEAD) < guard.index(ANCHOR),
         'guard_task_schema_anchor')
    block = guard[guard.index(HEAD):guard.index(ANCHOR)]
    need(all(("'" + name + "':").encode() not in block for name in tables), 'table_already_admitted')
    added = b''.join(("          '" + name + "': '" + columns + "',\n").encode() for name, columns in sorted(tables.items()))
    after = {'guard': guard.replace(ANCHOR, added + ANCHOR)}

    h = {name: sha(body).encode() for name, body in before.items()}
    admin = json.loads(before['admin_policy'])
    need(admin['sources']['native_guard.py'] == h['guard'].decode()
         and admin['native_guard_producer'].get('source_sha256') == h['guard'].decode(), 'admin_policy_baseline')
    # The guard hash is pinned twice: as a loaded source and as the producer.
    after['admin_policy'] = swap(before['admin_policy'], h['guard'], sha(after['guard']).encode(), 2,
                                 'admin_policy_guard_anchor')
    admin['sources']['native_guard.py'] = sha(after['guard'])
    admin['native_guard_producer']['source_sha256'] = sha(after['guard'])
    need(json.loads(after['admin_policy']) == admin, 'admin_policy_changed_beyond_pins')
    after['admin_unit'] = swap(before['admin_unit'], h['admin_policy'], sha(after['admin_policy']).encode(), 1,
                               'admin_unit_policy_anchor')
    return after
