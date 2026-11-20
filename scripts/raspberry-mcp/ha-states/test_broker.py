"""Synthetic suite for the read-only Home Assistant state broker."""
import json
import unittest
from pathlib import Path

import broker as B

POLICY = B.load_policy(str(Path(__file__).with_name('policy.json')))
NOW = 1_800_000_000.0
ISO = '2026-01-15T08:00:00+00:00'


class FakeHA:
    def __init__(self, rows=None, fail=()):
        self.rows, self.fail, self.calls = rows or {}, set(fail), []

    def state(self, entity_id):
        self.calls.append(entity_id)
        if entity_id in self.fail:
            raise OSError('down')
        return self.rows.get(entity_id)


def req(**args):
    return {'name': 'ha_states_read', 'arguments': {'host': 'raspberry', **args}}


class BrokerTests(unittest.TestCase):
    def test_policy_has_no_actuating_or_presence_domains(self):
        for entity_id in POLICY['entities']:
            self.assertRegex(entity_id, r'^(sensor|binary_sensor|input_boolean|update)\.')
            self.assertNotIn(entity_id.split('.')[0], ('alarm_control_panel', 'lock', 'switch', 'cover', 'person', 'device_tracker'))

    def test_live_value_with_measurement_time_age_and_availability(self):
        ha = FakeHA({'sensor.raspberry_pi_load_5m': {'state': '1.42', 'attributes': {'unit_of_measurement': 'load', 'friendly_name': 'x'},
                     'last_changed': ISO, 'last_updated': ISO, 'last_reported': '2026-01-15T08:00:30+00:00'}})
        out = B.handle(req(entity_id='sensor.raspberry_pi_load_5m'), POLICY, ha,
                       clock=lambda: B.stamp('2026-01-15T08:01:00+00:00'))
        row = out['entities'][0]
        self.assertEqual((out['state'], row['state'], row['unit'], row['available']), ('observed', '1.42', 'load', True))
        self.assertEqual((row['measured_at'], row['age_seconds']), ('2026-01-15T08:00:30+00:00', 30))
        self.assertEqual(row['attributes'], {})
        self.assertEqual(ha.calls, ['sensor.raspberry_pi_load_5m'])

    def test_unavailable_and_missing_are_not_available(self):
        ha = FakeHA({'sensor.controlador_ir_battery': {'state': 'unavailable', 'attributes': {}, 'last_updated': ISO}})
        rows = {r['entity_id']: r for r in B.handle(req(), POLICY, ha, clock=lambda: NOW)['entities']}
        self.assertFalse(rows['sensor.controlador_ir_battery']['available'])
        self.assertEqual(rows['sensor.raspberry_pi_health']['state'], 'missing')
        self.assertFalse(rows['sensor.raspberry_pi_health']['available'])
        self.assertEqual(len(rows), len(POLICY['entities']))

    def test_only_listed_short_attributes_leave(self):
        ha = FakeHA({'sensor.backup_result_git': {'state': 'confirmed', 'last_updated': ISO, 'attributes': {
            'freshness': 'fresh', 'reason': 'none', 'last_attempt_at': ISO, 'last_confirmed_at': None,
            'private_note': 'Rua Exemplo 123', 'friendly_name': 'Backup'}},
            'update.alexa_media_player_update': {'state': 'off', 'last_updated': ISO, 'attributes': {
                'installed_version': 'v5.20.0', 'latest_version': 'release notes with <html> and a long free text ' * 3}}})
        rows = {r['entity_id']: r for r in B.handle(req(), POLICY, ha, clock=lambda: NOW)['entities']}
        self.assertEqual(rows['sensor.backup_result_git']['attributes'],
                         {'reason': 'none', 'freshness': 'fresh', 'last_attempt_at': ISO, 'last_confirmed_at': None})
        self.assertNotIn('Rua', json.dumps(rows))
        self.assertEqual(rows['update.alexa_media_player_update']['attributes']['latest_version'], '[withheld]')

    def test_free_text_state_is_withheld(self):
        ha = FakeHA({'sensor.raspberry_pi_health': {'state': 'Contato: fulano@example.com', 'attributes': {}, 'last_updated': ISO}})
        row = B.handle(req(entity_id='sensor.raspberry_pi_health'), POLICY, ha, clock=lambda: NOW)['entities'][0]
        self.assertEqual(row['state'], '[withheld]')

    def test_unregistered_entities_and_extra_arguments_are_refused_without_reading(self):
        ha = FakeHA()
        for request in (req(entity_id='alarm_control_panel.security_panel'), req(entity_id='lock.vehicle_primary_door_lock'),
                        req(service='turn_on'), {'name': 'ha_light_set', 'arguments': {'host': 'raspberry'}},
                        {'name': 'ha_states_read', 'arguments': {'host': 'other'}}, {'name': 'ha_states_read'}):
            self.assertEqual(B.handle(request, POLICY, ha, clock=lambda: NOW)['state'], 'refused')
        self.assertEqual(ha.calls, [])

    def test_revoked_policy_refuses(self):
        policy = dict(POLICY, revoked=True)
        out = B.handle(req(), policy, FakeHA(), clock=lambda: NOW)
        self.assertEqual((out['state'], out['reason']), ('refused', 'state_reading_disabled'))

    def test_home_assistant_down_is_unknown_not_a_value(self):
        ha = FakeHA(fail=POLICY['entities'])
        out = B.handle(req(), POLICY, ha, clock=lambda: NOW)
        self.assertEqual((out['state'], out['collection_error']), ('unknown', 'home_assistant_unreachable'))
        ha = FakeHA({'sensor.raspberry_pi_uptime': {'state': '2', 'attributes': {}, 'last_updated': ISO}},
                    fail={'sensor.raspberry_pi_health'})
        self.assertEqual(B.handle(req(), POLICY, ha, clock=lambda: NOW)['collection_error'], 'partial_observation')

    def test_client_has_no_service_call_path(self):
        self.assertFalse(any(hasattr(B.HomeAssistant, name) for name in ('switch', 'call_service', 'post', '_request')))
        self.assertNotIn("method='POST'", Path(B.__file__).read_text())

    def test_policy_validation_rejects_wider_domains(self):
        path = Path(self.id().replace('.', '_') + '.json')
        try:
            bad = json.loads(Path(__file__).with_name('policy.json').read_text())
            bad['entities']['lock.front_door'] = {'label': 'x', 'attributes': []}
            path.write_text(json.dumps(bad))
            with self.assertRaises(B.Refused):
                B.load_policy(str(path))
        finally:
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
