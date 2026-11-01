"""Synthetic controller tests: no sockets, services, real policy or host state."""
import contextlib
import unittest
import controller

POLICY = {'enabled': True, 'recurring_execution_enabled': False,
    'target_kind': 'fixed_compose_nodered_service_on_existing_listener',
    'network_id': 'a' * 64, 'network_name': 'docker_default',
    'subnet': '192.0.2.0/24',
    'base_allow': ['127.0.0.0/8', '::1/128', '198.51.100.1/32'],
    'seed_peers': ['192.0.2.2'], 'unit_hashes': ['b' * 64]}
ARGS = {'host': 'raspberry', 'action': 'nodered_plan_reader_binding',
        'idempotency_key': 'nodered-peer-' + 'c' * 32}

class Store:
    def __init__(self): self.rows = []
    def lock(self): return contextlib.nullcontext()
    def history(self): return self.rows[:]
    def get(self, identifier): return next((r for r in self.rows if r['id'] == identifier), None)
    def revoked(self): return False
    def save(self, row):
        self.rows = [r for r in self.rows if r['id'] != row['id']] + [row]

class Manager:
    def __init__(self):
        self.allowed = sorted(POLICY['base_allow'] + ['192.0.2.2/32'])
        self.writes = 0
        self.fail = False
    def headroom(self): return True
    def inspect(self):
        return {'container_id': 'd'*64, 'image_id': 'e'*64,
            'network_id': POLICY['network_id'], 'network_name': POLICY['network_name'],
            'peer_ipv4': '192.0.2.3', 'running': True, 'unit_sha256': 'b'*64,
            'unit_active': 'inactive', 'deny_all': True, 'allowed': self.allowed[:],
            'logical_service_verified': True}
    def set_allow(self, expected, wanted):
        if expected != self.allowed: raise ValueError('conflict')
        self.writes += 1
        if self.fail: raise ValueError('unconfirmed')
        self.allowed = wanted[:]

class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.now = 100000
        self.store = Store(); self.manager = Manager()
        self.engine = controller.Controller(POLICY, self.store, self.manager, lambda: self.now)
    def request(self, action, tool='admin_action_apply'):
        return self.engine.request(tool, {**ARGS, 'action': action})
    def test_plan_apply_idempotency_and_restore(self):
        self.assertEqual(self.request(ARGS['action'])['state'], 'planned')
        self.assertEqual(self.manager.writes, 0)
        self.assertEqual(self.request('nodered_apply_reader_binding')['state'], 'applied')
        self.assertEqual(self.request('nodered_apply_reader_binding')['state'], 'applied')
        self.assertEqual(self.manager.writes, 1)
        self.now += 600
        self.assertEqual(self.request('nodered_plan_restore_reader_binding')['state'], 'restore_planned')
        self.assertEqual(self.request('nodered_restore_reader_binding')['state'], 'restored')
        self.assertEqual(self.manager.writes, 2)
    def test_expired_plan_and_uncertain_effect_do_not_retry(self):
        self.request(ARGS['action']); self.now += 900
        with self.assertRaises(controller.Refused): self.request('nodered_apply_reader_binding')
        self.assertEqual(self.manager.writes, 0)
        self.now -= 900; self.manager.fail = True
        self.assertEqual(self.request('nodered_apply_reader_binding')['state'], 'outcome_unknown')
        self.assertEqual(self.request('nodered_apply_reader_binding')['state'], 'outcome_unknown')
        self.assertEqual(self.manager.writes, 1)
    def test_unreviewed_fields_and_network_identity_refused(self):
        with self.assertRaises(controller.Refused):
            self.engine.request('admin_action_apply', {**ARGS, 'path': '/tmp'})
        self.request(ARGS['action'])
        self.manager.inspect = lambda: {'network_id': 'foreign'}
        with self.assertRaises(controller.Refused): self.request('nodered_apply_reader_binding')
        self.assertEqual(self.manager.writes, 0)

if __name__ == '__main__': unittest.main()
