import json
import os
import tempfile
import unittest

import broker as b

POLICY = b.load_policy(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'policy.json'))


class FakeHA:
    def __init__(self, states, follow=True, fail_call=False, fail_read=False):
        self.states, self.follow, self.fail_call, self.fail_read, self.calls = dict(states), follow, fail_call, fail_read, []

    def state(self, entity):
        if self.fail_read:
            raise OSError('down')
        return {'state': self.states.get(entity, 'missing'), 'last_changed': 't'}

    def switch(self, entity, on):
        self.calls.append((entity, on))
        if self.follow:
            self.states[entity] = 'on' if on else 'off'
        if self.fail_call:
            raise TimeoutError()


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def setreq(target='lampadas_garagem', state='on'):
    return {'name': 'ha_light_set', 'arguments': {'host': 'raspberry', 'target': target, 'state': state}}


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.ledger = b.Ledger(self.dir.name)
        self.clock = Clock()

    def run_req(self, req, ha, policy=POLICY):
        return b.handle(req, policy, ha, self.ledger, self.clock, self.clock.sleep)

    def test_turn_on_confirmed_by_readback_and_recorded(self):
        ha = FakeHA({'switch.lampadas_garagem': 'off'})
        r = self.run_req(setreq(), ha)
        self.assertEqual((r['state'], r['observed_state'], r['command_sent']), ('confirmed', 'on', True))
        self.assertEqual(ha.calls, [('switch.lampadas_garagem', True)])
        rows = json.load(open(os.path.join(self.dir.name, 'commands.json')))
        self.assertEqual(rows[0]['outcome'], 'confirmed')

    def test_already_on_sends_nothing(self):
        ha = FakeHA({'switch.lampadas_garagem': 'on'})
        r = self.run_req(setreq(), ha)
        self.assertEqual((r['state'], r['command_sent']), ('confirmed', False))
        self.assertEqual(ha.calls, [])

    def test_state_not_reached_is_unconfirmed_without_retry(self):
        ha = FakeHA({'switch.lampadas_garagem': 'off'}, follow=False)
        r = self.run_req(setreq(), ha)
        self.assertEqual(r['state'], 'unconfirmed')
        self.assertEqual(len(ha.calls), 1)

    def test_lost_response_is_uncertain_but_readback_can_confirm(self):
        ha = FakeHA({'switch.lampadas_garagem': 'off'}, follow=False, fail_call=True)
        self.assertEqual(self.run_req(setreq(), ha)['state'], 'uncertain')
        self.clock.t += 10
        ha2 = FakeHA({'switch.lampadas_garagem': 'off'}, follow=True, fail_call=True)
        self.assertEqual(self.run_req(setreq(), ha2)['state'], 'confirmed')

    def test_unregistered_targets_and_extra_fields_refused(self):
        ha = FakeHA({'switch.rele_acionador_portao': 'off'})
        for req in (setreq(target='rele_acionador_portao'), setreq(state='toggle'),
                    {'name': 'ha_light_set', 'arguments': {'host': 'raspberry', 'target': 'lampadas_garagem', 'state': 'on', 'entity_id': 'switch.rele_acionador_portao'}},
                    {'name': 'other', 'arguments': {'host': 'raspberry'}}):
            self.assertEqual(self.run_req(req, ha)['state'], 'refused')
        self.assertEqual(ha.calls, [])

    def test_unavailable_device_and_disabled_policy_refused(self):
        ha = FakeHA({'switch.lampadas_garagem': 'unavailable'})
        self.assertEqual(self.run_req(setreq(), ha)['reason'], 'device_unavailable')
        off = dict(POLICY, enabled=False)
        self.assertEqual(self.run_req(setreq(), FakeHA({'switch.lampadas_garagem': 'off'}), off)['reason'], 'lighting_control_disabled')
        self.assertEqual(self.run_req(setreq(), FakeHA({}, fail_read=True))['reason'], 'home_assistant_unreachable')

    def test_spacing_and_hourly_limit(self):
        ha = FakeHA({'switch.lampadas_garagem': 'off', 'switch.lampada_varanda': 'off'})
        self.assertEqual(self.run_req(setreq(), ha)['state'], 'confirmed')
        self.assertEqual(self.run_req(setreq('lampada_varanda'), ha)['reason'], 'minimum_spacing')
        for i in range(29):
            self.clock.t += 10
            self.run_req(setreq(state='off' if i % 2 == 0 else 'on'), ha)
        self.clock.t += 10
        self.assertEqual(self.run_req(setreq('lampada_varanda'), ha)['reason'], 'hourly_command_limit')

    def test_read_lists_all_registered_lights(self):
        ha = FakeHA({'switch.lampadas_garagem': 'on'})
        r = self.run_req({'name': 'ha_lights_read', 'arguments': {'host': 'raspberry'}}, ha)
        self.assertEqual(len(r['lights']), 5)
        garage = [x for x in r['lights'] if x['target'] == 'lampadas_garagem'][0]
        self.assertEqual((garage['state'], garage['available']), ('on', True))

    def test_policy_never_registers_the_gate_or_non_light_domains(self):
        ids = [row['entity_id'] for row in POLICY['targets'].values()]
        self.assertNotIn('switch.rele_acionador_portao', ids)
        self.assertTrue(all(i.split('.')[0] in ('switch', 'light') for i in ids))


if __name__ == '__main__':
    unittest.main()
