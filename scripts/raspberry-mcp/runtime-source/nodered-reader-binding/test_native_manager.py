"""Synthetic command/reader boundaries. No Docker/systemd/Root effects."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


n = load('binding_native_manager', 'native_manager.py')
c = load('binding_native_controller', 'controller.py')
f = load('binding_native_fixtures', 'test_controller.py')


class Store(f.Store):
    def assert_locked(self):
        if not self.mutex.locked():
            raise n.Refused('protected_locks_required')


class Runner:
    def __init__(self):
        self.calls = []
        self.writes = []
        self.allowed = sorted(f.policy()['base_allow'] + ['192.0.2.7/32'])
        self.peer = '192.0.2.6'
        self.cid = '1' * 64
        self.image = '2' * 64
        self.dropin = ''
        self.active = 'inactive'
        self.pid = '0'
        self.extra_network = False
        self.clear_then_fail = False
        self.alter = lambda props: props

    def inspect_container(self):
        self.calls.append(['fixed_Docker_GET', n.DOCKER_SOCKET])
        if self.extra_network:
            raise n.Refused('fixed_container_network_changed')
        return {'container_id':self.cid,'image_id':'sha256:'+self.image,
                'running':True,'network_id':'3'*64,'peer_ipv4':self.peer,
                'compose_service_verified':True,'published_bindings':[{'host_ip':'198.51.100.1','host_port':'1880'}]}

    def run(self, argv):
        self.calls.append(list(argv))
        if argv[2] == 'show':
            props = {'FragmentPath': n.FRAGMENT, 'DropInPaths': self.dropin,
                'ActiveState': self.active, 'MainPID': self.pid, 'LoadState': 'loaded',
                'Transient': 'no', 'IPAddressAllow': ' '.join(self.allowed),
                'IPAddressDeny': '0.0.0.0/0 ::/0'}
            return '\n'.join(k + '=' + v for k, v in self.alter(props).items()) + '\n'
        assert argv[:6] == [n.SYSTEMCTL, '--no-ask-password', '--runtime',
                           'set-property', n.UNIT, 'IPAddressAllow=']
        self.writes.append(list(argv))
        self.allowed = []
        if self.clear_then_fail:
            raise TimeoutError('synthetic partial property operation')
        self.allowed = sorted(v.split('=', 1)[1] for v in argv[6:])
        self.dropin = n.DROPIN
        return ''


class NativeManager(unittest.TestCase):
    def setUp(self):
        self.runner = Runner()
        self.store = Store()
        self.dependencies = {n.SIDECAR: '5' * 64, n.SNAPSHOT: '6' * 64}
        self.read_override = {}
        self.manager = n.Manager(f.policy(), self.runner, self.store,
                                 self.dependencies, reader=self.read)
        self.manager.headroom = lambda: True
        self.now = 100000
        self.controller = c.Controller(f.policy(), self.store, self.manager, lambda: self.now)

    def read(self, path, maximum=65536):
        if path in self.read_override:
            return self.read_override[path]
        if path == n.DROPIN:
            data = '# generated\n[Service]\nIPAddressAllow=\n' + ''.join(
                'IPAddressAllow=' + v + '\n' for v in self.runner.allowed)
            return '7' * 64, data.encode(), ()
        return ('4' * 64 if path == n.FRAGMENT else self.dependencies[path]), b'sealed code', ()

    def call(self, verb='plan', tool='admin_action_apply', key='a' * 32):
        return self.controller.request(tool, {'host': 'raspberry',
            'action': 'nodered_' + verb + '_reader_binding',
            'idempotency_key': 'nodered-peer-' + key})

    def test_fixed_inspect_only_returns_required_metadata(self):
        value = self.manager.inspect()
        self.assertEqual(value['container_id'], '1' * 64)
        self.assertEqual(value['peer_ipv4'], '192.0.2.6')
        self.assertEqual(len(self.runner.calls), 2)
        self.assertEqual(self.runner.calls[0], ['fixed_Docker_GET', n.DOCKER_SOCKET])
        self.assertEqual(self.runner.calls[1][2:4], ['show', n.UNIT])
        self.assertEqual(self.runner.writes, [])

    def test_plan_apply_replaces_old_peer_preserves_base_and_deny_all(self):
        self.call()
        result = self.call('apply')
        self.assertEqual(result['state'], 'applied')
        self.assertEqual(set(self.runner.allowed), set(f.policy()['base_allow'] + ['192.0.2.6/32']))
        self.assertNotIn('192.0.2.7/32', self.runner.allowed)
        self.assertEqual(len(self.runner.writes), 1)
        command = self.runner.writes[0]
        self.assertEqual(len(command), 10)
        self.assertEqual(command[:6], [n.SYSTEMCTL, '--no-ask-password', '--runtime',
                                      'set-property', n.UNIT, 'IPAddressAllow='])
        self.assertTrue(all(v.startswith('IPAddressAllow=') for v in command[6:]))
        self.assertNotIn('192.0.2', json.dumps(result))
        self.call('apply')
        self.assertEqual(len(self.runner.writes), 1)

    def test_restore_uses_own_original_networks_without_restart_or_dropin_deletion(self):
        original = list(self.runner.allowed)
        self.call()
        self.call('apply')
        self.now += 600
        self.call('plan_restore')
        self.assertEqual(self.call('restore')['state'], 'restored')
        self.assertEqual(self.runner.allowed, original)
        self.assertEqual(len(self.runner.writes), 2)
        self.assertEqual(self.runner.dropin, n.DROPIN)
        self.assertFalse(any('restart' in v or 'stop' in v for a in self.runner.calls for v in a))

    def test_dependency_or_fragment_hash_change_prevents_commands(self):
        for path in [n.SIDECAR, n.SNAPSHOT, n.FRAGMENT]:
            self.read_override[path] = ('f' * 64, b'foreign', ())
            with self.subTest(path=path), self.assertRaises(n.Refused):
                self.manager.inspect()
            self.read_override.clear()
        self.assertEqual(self.runner.calls, [])

    def test_unknown_dropin_path_and_foreign_directives_refused(self):
        self.runner.dropin = '/run/systemd/system/other.conf'
        with self.assertRaisesRegex(n.Refused, 'dropin'):
            self.manager.inspect()
        self.runner.dropin = n.DROPIN
        self.read_override[n.DROPIN] = ('7' * 64, b'[Service]\nExecStart=/tmp/free\n', ())
        with self.assertRaisesRegex(n.Refused, 'dropin'):
            self.manager.inspect()

    def test_known_own_dropin_matches_effective_prefixes_exactly(self):
        self.runner.dropin = n.DROPIN
        self.assertEqual(self.manager.inspect()['allowed'], self.runner.allowed)
        original = self.read(n.DROPIN)[1]
        self.read_override[n.DROPIN] = ('7' * 64, original.replace(b'192.0.2.7', b'192.0.2.99'), ())
        with self.assertRaisesRegex(n.Refused, 'disagree'):
            self.manager.inspect()

    def test_effective_unit_path_transient_deny_or_loaded_state_change_refused(self):
        for key, value in [('FragmentPath', '/tmp/foreign'), ('Transient', 'yes'),
                           ('IPAddressDeny', ''), ('LoadState', 'not-found')]:
            self.runner.alter = lambda props, k=key, v=value: {**props, k: v}
            with self.subTest(key=key), self.assertRaises(n.Refused):
                self.manager.inspect()
        self.assertEqual(self.runner.writes, [])

    def test_extra_network_or_inactive_nonzero_pid_refused(self):
        self.runner.extra_network = True
        with self.assertRaisesRegex(n.Refused, 'network_changed'):
            self.manager.inspect()
        self.runner.extra_network = False
        self.runner.pid = '345'
        with self.assertRaisesRegex(n.Refused, 'inactive'):
            self.manager.inspect()

    def test_changed_container_or_image_cannot_apply_existing_plan(self):
        self.call()
        for attribute in ('cid', 'image'):
            old = getattr(self.runner, attribute)
            setattr(self.runner, attribute, 'f' * 64)
            with self.subTest(attribute=attribute), self.assertRaises(c.Refused):
                self.call('apply')
            setattr(self.runner, attribute, old)
        self.assertEqual(self.runner.writes, [])

    def test_adapter_direct_call_requires_lock_and_single_durable_intent(self):
        original = list(self.runner.allowed)
        wanted = sorted(f.policy()['base_allow'] + ['192.0.2.6/32'])
        with self.assertRaisesRegex(n.Refused, 'locks_required'):
            self.manager.set_allow(original, wanted)
        with self.store.lock(), self.assertRaisesRegex(n.Refused, 'durable_binding_intent'):
            self.manager.set_allow(original, wanted)
        self.assertEqual(self.runner.writes, [])

    def test_lost_partial_write_is_unknown_and_duplicate_never_resets_again(self):
        self.call()
        self.runner.clear_then_fail = True
        self.assertEqual(self.call('apply')['state'], 'outcome_unknown')
        self.assertEqual(self.runner.allowed, [])
        self.assertEqual(self.call('apply')['state'], 'outcome_unknown')
        with self.assertRaises(c.Refused):
            self.call(key='b' * 32)
        with self.assertRaises(n.Refused):
            self.call(tool='admin_action_reconcile')
        self.assertEqual(len(self.runner.writes), 1)

    def test_final_compare_conflict_preserves_foreign_binding(self):
        self.call()
        with self.store.lock():
            row = self.store.get('a' * 32)
            row['state'] = 'apply_intent'
            self.store.save(row)
            self.runner.allowed = sorted(f.policy()['base_allow'] + ['192.0.2.99/32'])
            with self.assertRaisesRegex(n.Refused, 'final_compare'):
                self.manager.set_allow(row['before'], row['after'])
        self.assertEqual(self.runner.writes, [])

    def test_revocation_or_headroom_prevents_internal_writer(self):
        self.call()
        with self.store.lock():
            self.store.is_revoked = True
            with self.assertRaisesRegex(n.Refused, 'admission_closed'):
                self.manager.set_allow(self.runner.allowed, self.runner.allowed)
            self.store.is_revoked = False
            self.manager.headroom = lambda: False
            with self.assertRaisesRegex(n.Refused, 'admission_closed'):
                self.manager.set_allow(self.runner.allowed, self.runner.allowed)
        self.assertEqual(self.runner.writes, [])

    def test_arbitrary_commands_or_units_refused_before_any_exec(self):
        runner = n.PinnedRunner({n.SYSTEMCTL: '0' * 64})
        bad = [['/bin/sh', '-c', 'anything'], ['/usr/bin/docker', 'exec', 'nodered', 'sh'],
               [n.SYSTEMCTL, 'restart', 'nodered'],
               [n.SYSTEMCTL, '--no-pager', 'show', 'different.service'],
               [n.SYSTEMCTL, '--no-ask-password', '--runtime', 'set-property',
                n.UNIT, 'CPUQuota=100%']]
        with patch.object(n.subprocess, 'Popen') as execute:
            for argv in bad:
                with self.subTest(argv=argv), self.assertRaises(n.Refused):
                    runner.run(argv)
            execute.assert_not_called()

    def test_duplicate_missing_unknown_property_keys_refused(self):
        good = '\n'.join(k + '=value' for k in n.PROPERTIES)
        for raw in [good + '\nMainPID=0', good.replace('Transient=value', 'Other=value'),
                    good.replace('Transient=value', '')]:
            with self.subTest(raw=raw), self.assertRaises(n.Refused):
                n.property_values(raw)


class PinnedBoundaries(unittest.TestCase):
    def setUp(self):
        info = os.stat(n.SYSTEMCTL, follow_symlinks=False)
        self.identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        self.runner = n.PinnedRunner({n.SYSTEMCTL: '0' * 64})
        self.argv = [n.SYSTEMCTL, '--no-ask-password', '--runtime', 'set-property', n.UNIT,
                     'IPAddressAllow=', *['IPAddressAllow=' + v for v in
                         sorted(f.policy()['base_allow'] + ['192.0.2.6/32'])]]

    def process(self, still_running=False):
        read, write = os.pipe()
        os.close(write)
        stream = os.fdopen(read, 'rb')
        self.addCleanup(stream.close)
        process = Mock(stdout=stream)
        process.wait.return_value = 0
        process.poll.return_value = None if still_running else 0
        context = Mock()
        context.__enter__ = Mock(return_value=process)
        context.__exit__ = Mock(return_value=False)
        return process, context

    def test_single_write_shape_uses_pinned_fd_no_shell_and_clean_environment(self):
        process, context = self.process()
        with patch.object(n, 'root_file', return_value=('0' * 64, b'', self.identity)), \
                patch.object(n.subprocess, 'Popen', return_value=context) as execute:
            self.assertEqual(self.runner.run(self.argv), '')
        execute.assert_called_once()
        args, kwargs = execute.call_args
        self.assertEqual(args, (self.argv,))
        self.assertTrue(kwargs['executable'].startswith('/proc/self/fd/'))
        self.assertNotIn('shell', kwargs)
        self.assertEqual(set(kwargs['env']), {'PATH', 'LANG', 'LC_ALL'})
        self.assertEqual(kwargs['stdin'], n.subprocess.DEVNULL)
        self.assertTrue(kwargs['close_fds'])
        process.kill.assert_not_called()

    def test_deadline_kills_only_own_mock_cli_and_returns_unknown_without_retry(self):
        process, context = self.process(still_running=True)
        selector = Mock()
        selector.select.return_value = []
        selector_context = Mock(__enter__=Mock(return_value=selector), __exit__=Mock(return_value=False))
        with patch.object(n, 'root_file', return_value=('0' * 64, b'', self.identity)), \
                patch.object(n.subprocess, 'Popen', return_value=context) as execute, \
                patch.object(n.selectors, 'DefaultSelector', return_value=selector_context):
            with self.assertRaisesRegex(n.Refused, 'deadline_outcome_unconfirmed'):
                self.runner.run(self.argv)
        execute.assert_called_once()
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=2)

    def test_oversize_cli_response_is_bounded_and_not_retried(self):
        process, context = self.process(still_running=True)
        selector = Mock()
        selector.select.return_value = [('synthetic_ready',)]
        selector_context = Mock(__enter__=Mock(return_value=selector), __exit__=Mock(return_value=False))
        with patch.object(n, 'root_file', return_value=('0' * 64, b'', self.identity)), \
                patch.object(n.subprocess, 'Popen', return_value=context) as execute, \
                patch.object(n.selectors, 'DefaultSelector', return_value=selector_context), \
                patch.object(n.os, 'read', return_value=b'x' * 4096) as read:
            with self.assertRaisesRegex(n.Refused, 'output_limit'):
                self.runner.run(self.argv)
        self.assertEqual(read.call_count, 9)
        execute.assert_called_once()
        process.kill.assert_called_once()


if __name__ == '__main__':
    unittest.main()
