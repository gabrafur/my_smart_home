"""Exact-task admission, including the observer's authenticated live cache.

Preserves the frozen Kia deployment gate's identities, locks and busy checks.
An in-progress observation is not a terminal result or permission to replay.
"""
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3

def need(value, reason):
    if not value:
        raise ValueError(reason)

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def own_live_result(send):
    if send['result'] is None:
        return True
    if send['state'] != 'inProgress' or not isinstance(send['result'], str):
        return False
    try:
        value = json.loads(send['result'])
    except (ValueError, TypeError):
        return False
    return (isinstance(value, dict) and
        set(value) == {'operation_state', 'turn_id', 'started_at', 'completed_at'} and
        value['operation_state'] == 'inProgress' and value['turn_id'] == send['turn'] and
        type(value['started_at']) in (int, float) and math.isfinite(value['started_at']) and
        value['started_at'] >= 0 and value['completed_at'] is None)

def validate_task_context(manifest, phase, tasks, sends):
    expected = manifest['phases'][phase]
    selected = [row for row in tasks if row['id'] == expected['create']['operation_id']]
    need(len(selected) == 1, 'scoped_task_missing')
    task = selected[0]
    need(task['task_key'] == expected['create']['task_key'] and
        task['spec_hash'] == fingerprint(expected['create']) and task['state'] == 'created' and
        task['thread'] and task['reconciled'] == 1, 'scoped_task_identity_unconfirmed')
    need(all(row['reconciled'] == 1 for row in tasks), 'other_task_reserved')
    busy = {'create_intent', 'create_unknown', 'send_intent', 'send_unknown',
        'accepted', 'inProgress', 'outcome_unknown'}
    need(not any(row['state'] in busy for row in tasks), 'other_task_busy')
    need(not any(row['id'] != expected['send']['operation_id'] and row['state'] in busy for row in sends),
        'other_send_busy')
    active = [row for row in sends if not row['reconciled']]
    need(len(active) == 1, 'other_send_unresolved')
    send = active[0]
    need(send['id'] == expected['send']['operation_id'] and send['task'] == task['id'] and
        send['input_hash'] == fingerprint(expected['send']) and send['state'] in ('accepted', 'inProgress') and
        send['turn'] and own_live_result(send), 'scoped_send_unconfirmed')

def task_rows():
    connection = sqlite3.connect('file:/var/lib/raspberry-mcp-operations/task-control/jobs.sqlite3?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('PRAGMA query_only=ON')
        return ([dict(row) for row in connection.execute('select * from tasks')],
            [dict(row) for row in connection.execute('select * from sends')])
    finally:
        connection.close()

@contextlib.contextmanager
def locks(helper, manifest, phase, preflight=False):
    tasks = helper.chains()
    descriptors = []
    try:
        for path in ['/mnt/data/docker/.daily-maintenance.lock', '/var/lib/raspberry-mcp-operations/lock',
            '/var/lib/raspberry-admin-executor/executor.lock']:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            descriptors.append(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tasks.locked(read_only=True):
            need(tasks.legacy_summary()['busy'] == 0, 'legacy_operation_unresolved')
            task_list, send_list = task_rows()
            if preflight:
                need(all(row['reconciled'] == 1 and row['state'] not in
                    ('create_intent', 'create_unknown', 'send_intent', 'send_unknown', 'accepted', 'inProgress', 'outcome_unknown')
                    for row in task_list + send_list), 'operation_unresolved')
            else:
                validate_task_context(manifest, phase, task_list, send_list)
            for directory in ['.daily-update-trigger', '.git-backup-trigger']:
                need(not list((Path('/mnt/data/docker/homeassistant') / directory).glob('*processing*')),
                    'native_worker_processing')
            observed = False if preflight else any(row['id'] == manifest['phases'][phase]['send']['operation_id']
                and row['result'] is not None for row in send_list)
            yield {'own_live_progress_observed': observed, 'other_gates_preserved': True}
    finally:
        for fd in reversed(descriptors):
            os.close(fd)
