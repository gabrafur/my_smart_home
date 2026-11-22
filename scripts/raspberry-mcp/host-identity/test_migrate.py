"""Synthetic tests for the host identity migration operator and host_operator rendering."""
import hashlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MCP = HERE.parent
sys.path.insert(0, str(MCP))
import host_operator  # noqa: E402

spec = importlib.util.spec_from_file_location('host_identity_migrate', HERE / 'migrate.py')
migrate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate)

OPERATOR = {'user': 'example_operator', 'group': 'example_operator', 'home': '/home/example_operator'}


class Passwd:
    def __init__(self, uid=1001, home='/home/example_operator', group='example_operator'):
        self.uid, self.home, self.group = uid, home, group

    def getpwnam(self, name):
        if name != 'example_operator':
            raise KeyError(name)
        return type('Pw', (), {'pw_uid': self.uid, 'pw_gid': self.uid, 'pw_dir': self.home})()

    def getgrgid(self, gid):
        return type('Gr', (), {'gr_name': self.group})()


class HostOperator(unittest.TestCase):
    def resolve(self, explicit=None, environ=None, **kw):
        p = Passwd(**kw)
        return host_operator.resolve(explicit, environ or {}, p.getpwnam, p.getgrgid)

    def test_resolution_order_and_no_default(self):
        self.assertEqual(self.resolve('example_operator')['home'], '/home/example_operator')
        self.assertEqual(self.resolve(environ={'RASPBERRY_HOST_OPERATOR': 'example_operator', 'SUDO_USER': 'x'})['user'],
                         'example_operator')
        self.assertEqual(self.resolve(environ={'SUDO_USER': 'example_operator'})['group'], 'example_operator')
        with self.assertRaises(host_operator.OperatorUnresolved):
            self.resolve()

    def test_root_unknown_and_unsafe_accounts_are_refused(self):
        for kwargs in ({'explicit': 'root'}, {'explicit': 'other'}, {'explicit': 'example_operator', 'uid': 0},
                       {'explicit': 'example_operator', 'home': 'relative'},
                       {'explicit': 'example_operator', 'home': '/home/x/../root'},
                       {'explicit': 'example_operator', 'home': '/home/with space'},
                       {'explicit': 'Bad Name'}):
            with self.assertRaises(host_operator.OperatorUnresolved):
                self.resolve(**kwargs)

    def test_render_replaces_every_placeholder_and_refuses_unknown(self):
        out = host_operator.render(b'User=@HOST_OPERATOR_USER@\nGroup=@HOST_OPERATOR_GROUP@\nX=@HOST_OPERATOR_HOME@/a\n', OPERATOR)
        self.assertEqual(out, b'User=example_operator\nGroup=example_operator\nX=/home/example_operator/a\n')
        with self.assertRaises(host_operator.OperatorUnresolved):
            host_operator.render(b'@HOST_OPERATOR_SHELL@', OPERATOR)

    def test_tracked_units_are_templates(self):
        for rel in ('codex-account-status/raspberry-codex-account-status@.service',
                    'codex-peer-reenroll/raspberry-task-peer-reenroll.service'):
            body = (MCP / rel).read_bytes()
            self.assertIn(b'@HOST_OPERATOR_', body)
            self.assertNotIn(b'/home/', host_operator.render(body, OPERATOR).replace(b'/home/example_operator', b''))


class Aliases(unittest.TestCase):
    def setUp(self):
        self.policy_bytes = (MCP / 'ha-lights/policy.json').read_bytes()
        self.route_bytes = (MCP / 'ha-lights/lights-route.mjs').read_bytes()

    def test_without_aliases_sources_install_unchanged(self):
        self.assertEqual(migrate.render_policy(self.policy_bytes, {}), self.policy_bytes)
        self.assertEqual(migrate.render_route(self.route_bytes, {}), self.route_bytes)

    def test_alias_is_rendered_into_policy_and_route(self):
        aliases = {'example_legacy_pc': 'workstation_primary'}
        policy = json.loads(migrate.render_policy(self.policy_bytes, aliases))
        self.assertEqual(policy['actions']['example_legacy_pc'], policy['actions']['workstation_primary'])
        route = migrate.render_route(self.route_bytes, aliases).decode()
        self.assertIn('Object.freeze({"example_legacy_pc":"workstation_primary"});', route)
        self.assertNotIn(migrate.ALIAS_LINE, route)

    def test_invalid_aliases_are_refused(self):
        policy = json.loads(self.policy_bytes)
        for aliases in ({'portao_garagem': 'workstation_primary'}, {'lampada_varanda': 'workstation_primary'},
                        {'x': 'not_registered'}, {'Bad-Key': 'workstation_primary'}, ['x'],
                        {'a%d' % i: 'workstation_primary' for i in range(5)}):
            with self.assertRaises(migrate.Refused):
                migrate.validate_aliases(aliases, policy)


class Pins(unittest.TestCase):
    def test_sources_match_pins_and_differ_from_previous_bytes(self):
        for path, (_, rel, previous, pinned, kind) in migrate.FILES.items():
            body = (MCP / rel).read_bytes()
            self.assertEqual(hashlib.sha256(body).hexdigest(), pinned, rel)
            self.assertNotEqual(hashlib.sha256(body).hexdigest(), previous, rel)
            self.assertIn(kind, ('copy', 'operator', 'policy', 'route'))

    def test_installed_targets_cover_every_changed_component(self):
        self.assertEqual({row[0] for row in migrate.FILES.values()},
                         {'codex-account-status', 'codex-peer-reenroll', 'ha-lights'})
        self.assertEqual(migrate.OPTIONAL, {'codex-peer-reenroll'})


if __name__ == '__main__':
    unittest.main()
