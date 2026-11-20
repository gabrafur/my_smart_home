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
        return {'state': self.states.get(entity, 'missing'), 'last_changed': 't%d' % self.stamp}

    def call(self, domain, service, entity):
        self.calls.append((domain, service, entity))
        if self.fail_call:
            raise TimeoutError()
        if self.follow:
            if domain == 'switch':
                self.states[entity] = 'on' if service == 'turn_on' else 'off'
            else:
                self.stamp += 1

    stamp = 0

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


def actreq(target, action):
    return {'name': 'ha_action_run', 'arguments': {'host': 'raspberry', 'target': target, 'action': action}}


class ActionTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.ledger = b.Ledger(self.dir.name)
        self.clock = Clock()

    def run_req(self, req, ha, policy=POLICY):
        return b.handle(req, policy, ha, self.ledger, self.clock, self.clock.sleep)

    def test_air_conditioner_off_confirmed_and_on_sends_service(self):
        ha = FakeHA({'switch.ar_condicionado_escritorio_power': 'on'})
        r = self.run_req(actreq('ar_condicionado_escritorio', 'off'), ha)
        self.assertEqual((r['state'], r['observed_state']), ('confirmed', 'off'))
        self.assertEqual(ha.calls, [('switch', 'turn_off', 'switch.ar_condicionado_escritorio_power')])
        again = self.run_req(actreq('ar_condicionado_escritorio', 'off'), ha)
        self.assertEqual((again['command_sent'], again['state']), (False, 'confirmed'))

    def test_pc_poweroff_runs_only_the_registered_script_once(self):
        ha = FakeHA({'script.pc_desligar': 'off'})
        r = self.run_req(actreq('pc_gabriel', 'poweroff'), ha)
        self.assertEqual((r['state'], r['command_sent']), ('confirmed', True))
        self.assertEqual(ha.calls, [('script', 'turn_on', 'script.pc_desligar')])
        self.assertIn('effect_unverified', r)
        self.assertEqual(self.run_req(actreq('pc_gabriel', 'poweroff'), ha)['reason'], 'minimum_spacing')

    def test_gate_pulse_is_one_press_with_spacing_and_hourly_limit(self):
        ha = FakeHA({'button.acionar_portao_da_garagem': 'unknown'})
        r = self.run_req(actreq('portao_garagem', 'pulse'), ha)
        self.assertEqual((r['state'], len(ha.calls)), ('confirmed', 1))
        self.assertEqual(ha.calls[0], ('button', 'press', 'button.acionar_portao_da_garagem'))
        self.assertIn('position_unknown', r)
        self.clock.t += 5
        self.assertEqual(self.run_req(actreq('portao_garagem', 'pulse'), ha)['reason'], 'minimum_spacing')
        for _ in range(5):
            self.clock.t += 25
            self.assertEqual(self.run_req(actreq('portao_garagem', 'pulse'), ha)['state'], 'confirmed')
        self.clock.t += 25
        self.assertEqual(self.run_req(actreq('portao_garagem', 'pulse'), ha)['reason'], 'hourly_command_limit')
        self.assertEqual(len(ha.calls), 6)

    def test_gate_press_never_resent_when_unconfirmed_or_lost(self):
        ha = FakeHA({'button.acionar_portao_da_garagem': 'unknown'}, follow=False)
        self.assertEqual(self.run_req(actreq('portao_garagem', 'pulse'), ha)['state'], 'unconfirmed')
        lost = FakeHA({'button.acionar_portao_da_garagem': 'unknown'}, follow=False, fail_call=True)
        self.clock.t += 40
        self.assertEqual(self.run_req(actreq('portao_garagem', 'pulse'), lost)['state'], 'uncertain')
        self.assertEqual(len(ha.calls) + len(lost.calls), 2)

    def test_actions_are_closed_to_other_verbs_targets_and_fields(self):
        ha = FakeHA({'button.acionar_portao_da_garagem': 'unknown', 'switch.rele_acionador_portao': 'off'})
        for req in (actreq('portao_garagem', 'open'), actreq('portao_garagem', 'on'), actreq('pc_gabriel', 'reboot'),
                    actreq('rele_acionador_portao', 'pulse'), actreq('ar_condicionado_escritorio', 'pulse'),
                    {'name': 'ha_action_run', 'arguments': {'host': 'raspberry', 'target': 'portao_garagem', 'action': 'pulse', 'entity_id': 'x.y'}}):
            self.assertEqual(self.run_req(req, ha)['state'], 'refused')
        self.assertEqual(ha.calls, [])

    def test_disabled_policy_and_unavailable_gate_refuse_without_sending(self):
        ha = FakeHA({'button.acionar_portao_da_garagem': 'unavailable'})
        self.assertEqual(self.run_req(actreq('portao_garagem', 'pulse'), ha)['reason'], 'device_unavailable')
        off = dict(POLICY, enabled=False)
        self.assertEqual(self.run_req(actreq('portao_garagem', 'pulse'), FakeHA({'button.acionar_portao_da_garagem': 'unknown'}), off)['reason'], 'control_disabled')
        self.assertEqual(ha.calls, [])

    def test_actions_do_not_consume_the_lighting_budget_and_read_lists_three(self):
        ha = FakeHA({'button.acionar_portao_da_garagem': 'unknown', 'switch.lampadas_garagem': 'off'})
        self.run_req(actreq('portao_garagem', 'pulse'), ha)
        self.clock.t += 5
        self.assertEqual(self.run_req(setreq(), ha)['state'], 'confirmed')
        read = self.run_req({'name': 'ha_actions_read', 'arguments': {'host': 'raspberry'}}, FakeHA({'button.acionar_portao_da_garagem': 'unknown', 'script.pc_desligar': 'off', 'switch.ar_condicionado_escritorio_power': 'on'}))
        self.assertEqual([x['target'] for x in read['actions']], ['ar_condicionado_escritorio', 'pc_gabriel', 'portao_garagem'])
        self.assertTrue(all(x['available'] for x in read['actions']))


if __name__ == '__main__':
    unittest.main()
