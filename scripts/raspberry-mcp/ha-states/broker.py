"""Fixed read-only Home Assistant state broker for the Raspberry MCP.

One request per socket connection (systemd Accept=yes). Only the entities named in
the Root-owned policy can be read; no entity, domain, service, URL, attribute or
credential comes from the caller, and no Home Assistant service is ever called.
Each row carries the value, when Home Assistant last measured it, whether it is
available and how old it is. Free-text attributes never leave: only the attribute
names the policy lists for that entity, and only short scalar values.
"""
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

POLICY = '/usr/local/lib/raspberry-ha-states/policy.json'
HA_URL = 'http://127.0.0.1:8123'
MAX_REQUEST = 4096
TOOL = 'ha_states_read'
ENTITY = re.compile(r'(sensor|binary_sensor|input_boolean|update)\.[a-z0-9_]{1,80}')
ATTRIBUTE = re.compile(r'[a-z_]{1,40}')
# Short machine values only (versions, reasons, ISO timestamps, units); anything else is withheld.
SAFE_TEXT = re.compile(r'[A-Za-z0-9 ._:+%/°µ-]{0,64}')
UNAVAILABLE = ('unavailable', 'unknown', 'missing')


class Refused(Exception):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def load_policy(path=POLICY):
    with open(path, 'rb') as handle:
        policy = json.loads(handle.read(65537))
    need(type(policy) is dict and policy.get('schema') == 'ha_states_policy_v1', 'policy_schema')
    need(set(policy) == {'schema', 'enabled', 'revoked', 'entities'}, 'policy_shape')
    need(type(policy['enabled']) is bool and type(policy['revoked']) is bool, 'policy_flags')
    entities = policy['entities']
    need(type(entities) is dict and 0 < len(entities) <= 64, 'policy_entities')
    for entity_id, row in entities.items():
        need(ENTITY.fullmatch(entity_id), 'policy_entity')
        need(type(row) is dict and set(row) == {'label', 'attributes'}, 'policy_entity_shape')
        need(type(row['label']) is str and 0 < len(row['label']) <= 64, 'policy_label')
        need(type(row['attributes']) is list and len(row['attributes']) <= 8
             and all(type(a) is str and ATTRIBUTE.fullmatch(a) for a in row['attributes']), 'policy_attributes')
    return policy


def read_token():
    folder = os.environ.get('CREDENTIALS_DIRECTORY')
    need(folder, 'credential_unavailable')
    with open(os.path.join(folder, 'ha-token'), 'rb') as handle:
        value = handle.read(4097).strip().decode('ascii')
    need(0 < len(value) <= 4096 and re.fullmatch(r'[A-Za-z0-9._-]+', value), 'credential_invalid')
    return value


class HomeAssistant:
    """GET /api/states/<entity> only; this class has no way to call a service."""

    def __init__(self, token, base=HA_URL, timeout=6):
        self.token, self.base, self.timeout = token, base, timeout

    def state(self, entity_id):
        request = urllib.request.Request(self.base + '/api/states/' + entity_id, method='GET',
                                         headers={'Authorization': 'Bearer ' + self.token})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read(262145))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise


def scalar(value):
    if value is None or type(value) is bool:
        return value
    if type(value) in (int, float):
        return value if value == value and abs(value) < 1e15 else None
    if type(value) is str and SAFE_TEXT.fullmatch(value):
        return value
    return '[withheld]'


def stamp(value):
    if type(value) is not str:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed.timestamp() if parsed.tzinfo else None


def describe(entity_id, rule, ha, now):
    row = {'entity_id': entity_id, 'label': rule['label'], 'state': None, 'unit': None, 'attributes': {},
           'last_changed': None, 'last_updated': None, 'last_reported': None, 'measured_at': None,
           'age_seconds': None, 'available': False, 'collection_error': None}
    try:
        raw = ha.state(entity_id)
    except Exception:
        row['collection_error'] = 'home_assistant_unreachable'
        return row
    if raw is None:
        row['state'] = 'missing'
        return row
    if type(raw) is not dict:
        row['collection_error'] = 'home_assistant_response_invalid'
        return row
    attributes = raw.get('attributes') if type(raw.get('attributes')) is dict else {}
    state = scalar(raw.get('state'))
    for key in ('last_changed', 'last_updated', 'last_reported'):
        row[key] = raw[key] if stamp(raw.get(key)) is not None else None
    # last_reported moves on every report even when the value is unchanged: it is the measurement time.
    measured = row['last_reported'] or row['last_updated']
    measured_ts = stamp(measured)
    row.update(state=state, unit=scalar(attributes.get('unit_of_measurement')), measured_at=measured,
               age_seconds=None if measured_ts is None else max(0, round(now - measured_ts)),
               available=state not in UNAVAILABLE and state is not None,
               attributes={name: scalar(attributes.get(name)) for name in rule['attributes']})
    return row


def handle(request, policy, ha, clock=time.time):
    now = clock()
    base = {'source': 'fixed_home_assistant_state_broker', 'observed_at': now, 'automatic_retry': False,
            'coverage': ['live_home_assistant_rest_state', 'registered_entities_only', 'read_only_no_service_calls',
                         'not_device_functional_proof']}
    try:
        need(type(request) is dict and set(request) == {'name', 'arguments'}, 'request_refused')
        need(request['name'] == TOOL, 'parameters_refused')
        args = request['arguments']
        need(type(args) is dict and args.get('host') == 'raspberry' and set(args) <= {'host', 'entity_id'},
             'parameters_refused')
        need(args.get('entity_id') is None or args['entity_id'] in policy['entities'], 'entity_not_registered')
        need(policy['enabled'] and not policy['revoked'], 'state_reading_disabled')
    except Refused as error:
        return dict(base, state='refused', reason=str(error), collection_error=None)
    keys = [args['entity_id']] if args.get('entity_id') else sorted(policy['entities'])
    rows = [describe(key, policy['entities'][key], ha, now) for key in keys]
    failed = sum(1 for r in rows if r['collection_error'])
    return dict(base, state='observed' if failed < len(rows) else 'unknown', entities=rows,
                collection_error=None if not failed else ('partial_observation' if failed < len(rows)
                                                          else 'home_assistant_unreachable'))


def main():
    raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    try:
        need(0 < len(raw) <= MAX_REQUEST and raw.endswith(b'\n'), 'request_refused')
        request = json.loads(raw)
        result = handle(request, load_policy(), HomeAssistant(read_token()))
    except Refused as error:
        result = {'state': 'refused', 'reason': str(error), 'collection_error': None, 'automatic_retry': False}
    except Exception:
        result = {'state': 'unknown', 'collection_error': 'broker_failure', 'automatic_retry': False}
    sys.stdout.write(json.dumps(result, sort_keys=True, ensure_ascii=False) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
