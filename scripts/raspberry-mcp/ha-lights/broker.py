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
TOOLS = ('ha_lights_read', 'ha_light_set', 'ha_actions_read', 'ha_action_run', 'ha_entities_read', 'ha_service_call')
ENTITY = re.compile(r'(switch|light)\.[a-z0-9_]{1,64}')
# Household actions beyond lights. The kind fixes the Home Assistant service and the allowed
# verbs; nothing about the service comes from the caller or from the policy file.
ACTION_KINDS = {
    'power': {'domain': 'switch', 'verbs': ('on', 'off'), 'per_hour': 20, 'spacing': 5},
    'poweroff': {'domain': 'script', 'verbs': ('poweroff',), 'per_hour': 3, 'spacing': 30},
    'pulse': {'domain': 'button', 'verbs': ('pulse',), 'per_hour': 6, 'spacing': 20},
}
TARGET = re.compile(r'[a-z0-9_]{1,64}')


# Whole-house control (v4). The owner asked for Eva to reach every household device. The domain and
# service allowlist lives in the Root-owned policy; the denials below are code: the Raspberry's own
# power/restart controls, and the gate relay, which only the Node-RED pulse logic may drive.
DENIED_ENTITIES = frozenset({'script.raspberry_desligar', 'script.raspberry_reiniciar', 'switch.rele_acionador_portao',
                             'script.portao_garagem_acionar', 'script.portao_garagem_pulso'})
DENIED_SUFFIX = ('_restart', '_reboot', '_core_restart')
DATA_KEYS = frozenset({'brightness', 'brightness_pct', 'color_temp_kelvin', 'rgb_color', 'color_name', 'transition', 'effect',
                       'temperature', 'target_temp_high', 'target_temp_low', 'hvac_mode', 'fan_mode', 'preset_mode',
                       'swing_mode', 'volume_level', 'is_volume_muted', 'source', 'media_content_id', 'media_content_type',
                       'position', 'percentage', 'oscillating', 'command', 'device', 'num_repeats', 'delay_secs',
                       'fan_speed', 'value', 'option', 'humidity'})
STRICT_DOMAINS = {'lock': (10, 10), 'alarm_control_panel': (10, 10)}  # (per hour, spacing seconds)
# Accepted final states read back after a service call; a call without an entry returns `accepted`.
MEDIA_ON = ('on', 'idle', 'playing', 'paused', 'buffering')
GENERIC_EXPECT = {('light', 'turn_on'): ('on',), ('light', 'turn_off'): ('off',), ('switch', 'turn_on'): ('on',),
                  ('switch', 'turn_off'): ('off',), ('fan', 'turn_on'): ('on',), ('fan', 'turn_off'): ('off',),
                  ('lock', 'lock'): ('locked',), ('lock', 'unlock'): ('unlocked', 'open'), ('lock', 'open'): ('open', 'unlocked'),
                  ('media_player', 'turn_on'): MEDIA_ON, ('media_player', 'turn_off'): ('off', 'standby'),
                  ('media_player', 'media_play'): ('playing', 'buffering'), ('media_player', 'media_pause'): ('paused', 'idle'),
                  ('media_player', 'media_stop'): ('idle', 'off', 'standby', 'on'),
                  ('climate', 'turn_off'): ('off',), ('cover', 'open_cover'): ('open', 'opening'),
                  ('cover', 'close_cover'): ('closed', 'closing'), ('input_boolean', 'turn_on'): ('on',),
                  ('input_boolean', 'turn_off'): ('off',), ('vacuum', 'start'): ('cleaning',),
                  ('vacuum', 'pause'): ('paused', 'idle'), ('vacuum', 'stop'): ('idle', 'paused', 'docked'),
                  ('vacuum', 'return_to_base'): ('returning', 'docked'),
                  ('alarm_control_panel', 'alarm_arm_away'): ('armed_away', 'arming'),
                  ('alarm_control_panel', 'alarm_arm_home'): ('armed_home', 'arming'),
                  ('alarm_control_panel', 'alarm_arm_night'): ('armed_night', 'arming'),
                  ('alarm_control_panel', 'alarm_disarm'): ('disarmed',)}
# Slow devices (a TV waking over the network, a vacuum leaving the dock) get a longer read-back window.
READBACK_SECONDS = {'media_player': 20, 'vacuum': 15, 'cover': 15, 'alarm_control_panel': 15, 'climate': 10}


def generic_expect(domain, service, data):
    if (domain, service) == ('climate', 'set_hvac_mode') and type(data.get('hvac_mode')) is str:
        return (data['hvac_mode'],)
    return GENERIC_EXPECT.get((domain, service))
ENTITY_ANY = re.compile(r'[a-z_]{1,32}\.[a-z0-9_]{1,96}')
SERVICE = re.compile(r'[a-z_]{1,48}')


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
    actions = policy.get('actions', {})
    need(type(actions) is dict and len(actions) <= 16, 'policy_actions')
    for key, row in actions.items():
        need(TARGET.fullmatch(key) and type(row) is dict and set(row) == {'entity_id', 'label', 'kind'}, 'policy_action_shape')
        need(row['kind'] in ACTION_KINDS, 'policy_action_kind')
        need(type(row['entity_id']) is str and re.fullmatch(ACTION_KINDS[row['kind']]['domain'] + r'\.[a-z0-9_]{1,64}', row['entity_id']), 'policy_action_entity')
        need(type(row['label']) is str and 0 < len(row['label']) <= 64, 'policy_action_label')
    generic = policy.get('generic')
    if generic is not None:
        need(type(generic) is dict and set(generic) == {'domains', 'per_hour', 'spacing_seconds'}, 'policy_generic')
        need(type(generic['domains']) is dict and 0 < len(generic['domains']) <= 64, 'policy_generic_domains')
        for domain, services in generic['domains'].items():
            need(SERVICE.fullmatch(domain) and type(services) is list and 0 < len(services) <= 64
                 and all(type(x) is str and SERVICE.fullmatch(x) for x in services), 'policy_generic_services')
        need(all(type(generic[k]) is int and 0 < generic[k] <= 3600 for k in ('per_hour', 'spacing_seconds')), 'policy_generic_limits')
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

    def call(self, domain, service, entity_id, data=None):
        self._request('POST', '/api/services/%s/%s' % (domain, service), dict(data or {}, entity_id=entity_id))

    def all_states(self):
        return self._request('GET', '/api/states')


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


def check_data(data):
    need(type(data) is dict and len(data) <= 8 and set(data) <= DATA_KEYS, 'data_refused')
    for value in data.values():
        scalar = type(value) in (str, int, float, bool) and (type(value) is not str or len(value) <= 512)
        listed = type(value) is list and len(value) <= 4 and all(type(x) in (int, float) for x in value)
        need(scalar or listed, 'data_refused')


def check_generic(name, args, policy):
    generic = policy.get('generic')
    need(generic is not None, 'generic_control_not_installed')
    if name == 'ha_entities_read':
        need(set(args) <= {'host', 'domain', 'search'}, 'parameters_refused')
        need(args.get('domain') is None or args['domain'] in generic['domains'], 'domain_not_registered')
        need(args.get('search') is None or (type(args['search']) is str and 0 < len(args['search']) <= 64), 'parameters_refused')
        return
    need(set(args) <= {'host', 'domain', 'service', 'entity_id', 'data'} and {'host', 'domain', 'service', 'entity_id'} <= set(args), 'parameters_refused')
    need(args['domain'] in generic['domains'] and args['service'] in generic['domains'][args['domain']], 'service_not_registered')
    need(type(args['entity_id']) is str and ENTITY_ANY.fullmatch(args['entity_id']) and args['entity_id'].split('.')[0] == args['domain'], 'entity_refused')
    need(args['entity_id'] not in DENIED_ENTITIES and not args['entity_id'].endswith(DENIED_SUFFIX), 'entity_denied')
    check_data(args.get('data', {}))


def check_args(name, args, policy):
    need(name in TOOLS and type(args) is dict and args.get('host') == 'raspberry', 'parameters_refused')
    if name in ('ha_entities_read', 'ha_service_call'):
        return check_generic(name, args, policy)
    actions = policy.get('actions', {})
    if name == 'ha_actions_read':
        need(set(args) <= {'host', 'target'}, 'parameters_refused')
        need(args.get('target') is None or args['target'] in actions, 'target_not_registered')
        return
    if name == 'ha_action_run':
        need(set(args) == {'host', 'target', 'action'}, 'parameters_refused')
        need(args['target'] in actions, 'target_not_registered')
        need(args['action'] in ACTION_KINDS[actions[args['target']]['kind']]['verbs'], 'action_refused')
        return
    if name == 'ha_lights_read':
        need(set(args) <= {'host', 'target'}, 'parameters_refused')
        need(args.get('target') is None or args['target'] in policy['targets'], 'target_not_registered')
    else:
        need(set(args) == {'host', 'target', 'state'}, 'parameters_refused')
        need(args['target'] in policy['targets'], 'target_not_registered')
        need(args['state'] in ('on', 'off'), 'state_refused')


def describe_action(policy, key, ha):
    row = policy['actions'][key]
    try:
        observed = ha.state(row['entity_id'])
        error = None
    except Exception:
        observed, error = {'state': 'unknown', 'last_changed': None}, 'home_assistant_unreachable'
    kind = row['kind']
    usable = observed['state'] in ('on', 'off') if kind == 'power' else observed['state'] not in ('unavailable', 'missing')
    if error:
        usable = False
    return {'target': key, 'label': row['label'], 'kind': kind, 'verbs': list(ACTION_KINDS[kind]['verbs']),
            'state': observed['state'] if kind == 'power' else ('ready' if usable else observed['state']),
            'last_changed': observed['last_changed'], 'available': usable, 'collection_error': error}


def entities_read(args, policy, ha, base):
    generic = policy['generic']
    try:
        rows = ha.all_states()
    except Exception:
        return dict(base, state='unknown', collection_error='home_assistant_unreachable')
    needle = (args.get('search') or '').lower()
    out = []
    for row in rows:
        entity = row.get('entity_id', '')
        domain = entity.split('.', 1)[0]
        name = (row.get('attributes') or {}).get('friendly_name') or ''
        if domain not in generic['domains'] or entity in DENIED_ENTITIES or entity.endswith(DENIED_SUFFIX):
            continue
        if args.get('domain') and domain != args['domain']:
            continue
        if needle and needle not in entity.lower() and needle not in str(name).lower():
            continue
        out.append({'entity_id': entity, 'name': str(name)[:64], 'state': str(row.get('state'))[:32],
                    'services': generic['domains'][domain]})
    out.sort(key=lambda r: r['entity_id'])
    return dict(base, state='observed', entities=out[:100], total=len(out), truncated=len(out) > 100,
                control_enabled=policy['enabled'] and not policy['revoked'], collection_error=None)


def service_call(args, policy, ha, ledger, clock, sleep, base):
    generic = policy['generic']
    domain, service, entity, data = args['domain'], args['service'], args['entity_id'], args.get('data', {})
    if not policy['enabled'] or policy['revoked']:
        return dict(base, state='refused', reason='control_disabled', entity_id=entity, command_sent=False, collection_error=None)
    now = clock()
    try:
        before = ha.state(entity)
    except Exception:
        return dict(base, state='refused', reason='home_assistant_unreachable', entity_id=entity, command_sent=False, collection_error=None)
    if before['state'] in ('missing', 'unavailable'):
        return dict(base, state='refused', reason='device_unavailable' if before['state'] == 'unavailable' else 'entity_not_found',
                    entity_id=entity, command_sent=False, collection_error=None)
    per_hour, spacing = STRICT_DOMAINS.get(domain, (generic['per_hour'], generic['spacing_seconds']))
    with ledger as book:
        recent = [r for r in book.rows if r.get('scope') == 'generic' and r.get('strict') == (domain in STRICT_DOMAINS)
                  and now - r['at'] < 3600]
        if len(recent) >= per_hour:
            return dict(base, state='refused', reason='hourly_command_limit', entity_id=entity, command_sent=False, collection_error=None)
        if recent and now - max(r['at'] for r in recent) < spacing:
            return dict(base, state='refused', reason='minimum_spacing', entity_id=entity, command_sent=False, collection_error=None)
        entry = {'at': now, 'scope': 'generic', 'strict': domain in STRICT_DOMAINS, 'entity_id': entity,
                 'service': domain + '.' + service, 'before': before['state'], 'outcome': 'intent_recorded'}
        book.rows.append(entry)
        book.save(now)
        try:
            ha.call(domain, service, entity, data)
            sent = 'accepted'
        except Exception:
            sent = 'uncertain'
        expect = generic_expect(domain, service, data)
        window = max(policy['limits']['readback_seconds'], READBACK_SECONDS.get(domain, 0))
        deadline = clock() + (window if expect else 2)
        observed = before
        while True:
            try:
                observed = ha.state(entity)
            except Exception:
                observed = {'state': 'unknown', 'last_changed': None}
            done = observed['state'] in expect if expect else clock() >= deadline
            if done or clock() >= deadline:
                break
            sleep(0.5)
        if expect:
            outcome = 'confirmed' if observed['state'] in expect else ('uncertain' if sent == 'uncertain' else 'unconfirmed')
        else:
            outcome = 'accepted' if sent == 'accepted' else 'uncertain'
        entry['outcome'], entry['observed'], entry['service_call'] = outcome, observed['state'], sent
        book.save(clock())
    return dict(base, state=outcome, entity_id=entity, service=domain + '.' + service, before_state=before['state'],
                observed_state=observed['state'], command_sent=True, service_call=sent, collection_error=None,
                note=None if outcome in ('confirmed', 'accepted') else 'observe with ha_entities_read; the command is never resent automatically')


def run_action(request, policy, ha, ledger, clock, sleep, base):
    args = request['arguments']
    key, verb = args['target'], args['action']
    row = policy['actions'][key]
    kind = ACTION_KINDS[row['kind']]
    entity = row['entity_id']
    if not policy['enabled'] or policy['revoked']:
        return dict(base, state='refused', reason='control_disabled', target=key, command_sent=False, collection_error=None)
    now = clock()
    try:
        before = ha.state(entity)
    except Exception:
        return dict(base, state='refused', reason='home_assistant_unreachable', target=key, command_sent=False,
                    collection_error=None)
    if row['kind'] == 'power' and before['state'] == verb:
        return dict(base, state='confirmed', target=key, label=row['label'], requested=verb, observed_state=before['state'],
                    command_sent=False, reason='already_in_requested_state', collection_error=None)
    if before['state'] in ('unavailable', 'missing') or (row['kind'] == 'power' and before['state'] not in ('on', 'off')):
        return dict(base, state='refused', target=key, reason='device_unavailable', observed_state=before['state'],
                    command_sent=False, collection_error=None)
    with ledger as book:
        recent = [r for r in book.rows if r.get('scope') == 'action' and r.get('kind') == row['kind'] and now - r['at'] < 3600]
        if len(recent) >= kind['per_hour']:
            return dict(base, state='refused', target=key, reason='hourly_command_limit', command_sent=False,
                        collection_error=None)
        if recent and now - max(r['at'] for r in recent) < kind['spacing']:
            return dict(base, state='refused', target=key, reason='minimum_spacing', command_sent=False,
                        collection_error=None)
        entry = {'at': now, 'scope': 'action', 'kind': row['kind'], 'target': key, 'entity_id': entity,
                 'requested': verb, 'before': before['state'], 'outcome': 'intent_recorded'}
        book.rows.append(entry)
        book.save(now)
        try:
            if row['kind'] == 'power':
                ha.call('switch', 'turn_on' if verb == 'on' else 'turn_off', entity)
            elif row['kind'] == 'poweroff':
                ha.call('script', 'turn_on', entity)
            else:
                ha.call('button', 'press', entity)
            sent = 'accepted'
        except Exception:
            sent = 'uncertain'
        deadline = clock() + policy['limits']['readback_seconds']
        observed = before
        while True:
            try:
                observed = ha.state(entity)
            except Exception:
                observed = {'state': 'unknown', 'last_changed': None}
            reached = observed['state'] == verb if row['kind'] == 'power' else observed['last_changed'] != before['last_changed']
            if reached or clock() >= deadline:
                break
            sleep(0.5)
        if reached:
            outcome = 'confirmed'
        else:
            outcome = 'uncertain' if sent == 'uncertain' else 'unconfirmed'
        entry['outcome'], entry['observed'], entry['service_call'] = outcome, observed['state'], sent
        book.save(clock())
    result = dict(base, state=outcome, target=key, label=row['label'], requested=verb, before_state=before['state'],
                  observed_state=observed['state'], command_sent=True, service_call=sent, collection_error=None,
                  note=None if outcome == 'confirmed' else 'observe with ha_actions_read; the command is never resent automatically')
    if row['kind'] == 'pulse':
        result['position_unknown'] = 'one pulse runs the next step of the gate cycle (open, stop, close); there is no position sensor'
    if row['kind'] == 'poweroff':
        result['effect_unverified'] = 'Home Assistant ran the shutdown script; the PC state is not read back'
    return result


def handle(request, policy, ha, ledger, clock=time.time, sleep=time.sleep):
    now = clock()
    base = {'source': 'fixed_home_assistant_lighting_broker', 'observed_at': now, 'automatic_retry': False}
    try:
        need(type(request) is dict and set(request) == {'name', 'arguments'}, 'request_refused')
        check_args(request['name'], request['arguments'], policy)
    except Refused as error:
        return dict(base, state='refused', reason=str(error), collection_error=None)
    args = request['arguments']
    if request['name'] == 'ha_entities_read':
        return entities_read(args, policy, ha, base)
    if request['name'] == 'ha_service_call':
        return service_call(args, policy, ha, ledger, clock, sleep, base)
    if request['name'] == 'ha_actions_read':
        keys = [args['target']] if args.get('target') else sorted(policy.get('actions', {}))
        rows = [describe_action(policy, key, ha) for key in keys]
        return dict(base, state='observed', actions=rows, control_enabled=policy['enabled'] and not policy['revoked'],
                    collection_error=None if all(r['collection_error'] is None for r in rows) else 'partial_observation')
    if request['name'] == 'ha_action_run':
        return run_action(request, policy, ha, ledger, clock, sleep, base)
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
        recent = [r for r in book.rows if r.get('scope') != 'action' and now - r['at'] < 3600]
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
