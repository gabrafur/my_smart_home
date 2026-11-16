"""Fixed Home Assistant lighting broker for the Raspberry MCP.

One request per socket connection (systemd Accept=yes). Only the lighting
switches named in the Root-owned policy can be read or switched on/off; no
entity, domain, service, URL or credential comes from the caller. Every command
is recorded before it is sent, rate limited, never retried, and followed by a
readback of the real Home Assistant state. A lost response is reported as
``uncertain`` with whatever state the readback observed.
"""
import fcntl
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

POLICY = '/usr/local/lib/raspberry-ha-lights/policy.json'
HA_URL = 'http://127.0.0.1:8123'
MAX_REQUEST = 4096
LEDGER_KEEP_SECONDS = 86400
LEDGER_MAX_ROWS = 512
TOOLS = ('ha_lights_read', 'ha_light_set')
ENTITY = re.compile(r'(switch|light)\.[a-z0-9_]{1,64}')
TARGET = re.compile(r'[a-z0-9_]{1,64}')


class Refused(Exception):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def load_policy(path=POLICY):
    with open(path, 'rb') as handle:
        policy = json.loads(handle.read(65537))
    need(type(policy) is dict and policy.get('schema') == 'ha_lights_policy_v1', 'policy_schema')
    need(type(policy.get('enabled')) is bool and type(policy.get('revoked')) is bool, 'policy_flags')
    targets = policy.get('targets')
    need(type(targets) is dict and 0 < len(targets) <= 32, 'policy_targets')
    for key, row in targets.items():
        need(TARGET.fullmatch(key) and type(row) is dict and set(row) == {'entity_id', 'label'}, 'policy_target_shape')
        need(type(row['entity_id']) is str and ENTITY.fullmatch(row['entity_id']), 'policy_entity')
        need(type(row['label']) is str and 0 < len(row['label']) <= 64, 'policy_label')
    limits = policy.get('limits')
    need(type(limits) is dict and set(limits) == {'commands_per_hour', 'minimum_spacing_seconds', 'readback_seconds'}, 'policy_limits')
    need(all(type(v) is int and 0 < v <= 3600 for v in limits.values()), 'policy_limit_values')
    return policy


def read_token():
    folder = os.environ.get('CREDENTIALS_DIRECTORY')
    need(folder, 'credential_unavailable')
    with open(os.path.join(folder, 'ha-token'), 'rb') as handle:
        value = handle.read(4097).strip().decode('ascii')
    need(0 < len(value) <= 4096 and re.fullmatch(r'[A-Za-z0-9._-]+', value), 'credential_invalid')
    return value


class HomeAssistant:
    def __init__(self, token, base=HA_URL, timeout=8):
        self.token, self.base, self.timeout = token, base, timeout

    def _request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read(1048577))

    def state(self, entity_id):
        try:
            row = self._request('GET', '/api/states/' + entity_id)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return {'state': 'missing', 'last_changed': None}
            raise
        return {'state': row.get('state'), 'last_changed': row.get('last_changed')}

    def switch(self, entity_id, on):
        domain = entity_id.split('.', 1)[0]
        self._request('POST', '/api/services/%s/%s' % (domain, 'turn_on' if on else 'turn_off'),
                      {'entity_id': entity_id})


class Ledger:
    """Durable command intents/results under one flock; history is never reset."""

    def __init__(self, folder):
        self.path = os.path.join(folder, 'commands.json')
        self.lock = os.path.join(folder, 'ledger.lock')

    def __enter__(self):
        self.fd = os.open(self.lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        try:
            with open(self.path, 'rb') as handle:
                self.rows = json.loads(handle.read())
        except FileNotFoundError:
            self.rows = []
        need(type(self.rows) is list, 'ledger_invalid')
        return self

    def __exit__(self, *exc):
        os.close(self.fd)

    def save(self, now):
        self.rows = [r for r in self.rows if now - r['at'] < LEDGER_KEEP_SECONDS][-LEDGER_MAX_ROWS:]
        temporary = self.path + '.tmp'
        with open(temporary, 'w') as handle:
            json.dump(self.rows, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)


def describe(policy, key, ha):
    row = policy['targets'][key]
    try:
        observed = ha.state(row['entity_id'])
        error = None
    except Exception:
        observed, error = {'state': 'unknown', 'last_changed': None}, 'home_assistant_unreachable'
    return {'target': key, 'label': row['label'], 'entity_id': row['entity_id'], 'state': observed['state'],
            'last_changed': observed['last_changed'], 'available': observed['state'] in ('on', 'off'),
            'collection_error': error}


def check_args(name, args, policy):
    need(name in TOOLS and type(args) is dict and args.get('host') == 'raspberry', 'parameters_refused')
    if name == 'ha_lights_read':
        need(set(args) <= {'host', 'target'}, 'parameters_refused')
        need(args.get('target') is None or args['target'] in policy['targets'], 'target_not_registered')
    else:
        need(set(args) == {'host', 'target', 'state'}, 'parameters_refused')
        need(args['target'] in policy['targets'], 'target_not_registered')
        need(args['state'] in ('on', 'off'), 'state_refused')


def handle(request, policy, ha, ledger, clock=time.time, sleep=time.sleep):
    now = clock()
    base = {'source': 'fixed_home_assistant_lighting_broker', 'observed_at': now, 'automatic_retry': False}
    try:
        need(type(request) is dict and set(request) == {'name', 'arguments'}, 'request_refused')
        check_args(request['name'], request['arguments'], policy)
    except Refused as error:
        return dict(base, state='refused', reason=str(error), collection_error=None)
    args = request['arguments']
    if request['name'] == 'ha_lights_read':
        keys = [args['target']] if args.get('target') else sorted(policy['targets'])
        rows = [describe(policy, key, ha) for key in keys]
        return dict(base, state='observed', lights=rows, control_enabled=policy['enabled'] and not policy['revoked'],
                    collection_error=None if all(r['collection_error'] is None for r in rows) else 'partial_observation')
    key, wanted = args['target'], args['state']
    entity = policy['targets'][key]['entity_id']
    if not policy['enabled'] or policy['revoked']:
        return dict(base, state='refused', reason='lighting_control_disabled', target=key, collection_error=None)
    before = describe(policy, key, ha)
    if before['collection_error']:
        return dict(base, state='refused', reason='home_assistant_unreachable', target=key, command_sent=False,
                    collection_error=None)
    if before['state'] == wanted:
        return dict(base, state='confirmed', target=key, label=before['label'], requested=wanted,
                    observed_state=before['state'], command_sent=False, reason='already_in_requested_state',
                    collection_error=None)
    if not before['available']:
        return dict(base, state='refused', target=key, reason='device_unavailable', observed_state=before['state'],
                    command_sent=False, collection_error=None)
    limits = policy['limits']
    with ledger as book:
        recent = [r for r in book.rows if now - r['at'] < 3600]
        if len(recent) >= limits['commands_per_hour']:
            return dict(base, state='refused', target=key, reason='hourly_command_limit', command_sent=False,
                        collection_error=None)
        if recent and now - max(r['at'] for r in recent) < limits['minimum_spacing_seconds']:
            return dict(base, state='refused', target=key, reason='minimum_spacing', command_sent=False,
                        collection_error=None)
        row = {'at': now, 'target': key, 'entity_id': entity, 'requested': wanted, 'before': before['state'],
               'outcome': 'intent_recorded'}
        book.rows.append(row)
        book.save(now)
        try:
            ha.switch(entity, wanted == 'on')
            sent = 'accepted'
        except Exception:
            sent = 'uncertain'
        deadline = clock() + limits['readback_seconds']
        observed = before['state']
        while True:
            try:
                observed = ha.state(entity)['state']
            except Exception:
                observed = 'unknown'
            if observed == wanted or clock() >= deadline:
                break
            sleep(0.5)
        outcome = 'confirmed' if observed == wanted else ('uncertain' if sent == 'uncertain' else 'unconfirmed')
        row['outcome'], row['observed'], row['service_call'] = outcome, observed, sent
        book.save(clock())
    return dict(base, state=outcome, target=key, label=before['label'], requested=wanted, before_state=before['state'],
                observed_state=observed, command_sent=True, service_call=sent, collection_error=None,
                note=None if outcome == 'confirmed' else 'observe with ha_lights_read; the command is never resent automatically')


def main():
    raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    try:
        need(0 < len(raw) <= MAX_REQUEST and raw.endswith(b'\n'), 'request_refused')
        request = json.loads(raw)
        policy = load_policy()
        result = handle(request, policy, HomeAssistant(read_token()),
                        Ledger(os.environ.get('STATE_DIRECTORY', '/var/lib/raspberry-ha-lights')))
    except Refused as error:
        result = {'state': 'refused', 'reason': str(error), 'collection_error': None, 'automatic_retry': False}
    except Exception:
        result = {'state': 'unknown', 'collection_error': 'broker_failure', 'automatic_retry': False}
    sys.stdout.write(json.dumps(result, sort_keys=True) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
