"""Real disposable protected-file tests; code load only, no Root execution."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import bootstrap as b

HERE = Path(__file__).parent


class Bootstrap(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lib = Path(self.temp.name) / 'lib'
        self.lib.mkdir(mode=0o755)
        hashes = {}
        for name in b.FILES:
            raw = (HERE / name).read_bytes()
            target = self.lib / name
            target.write_bytes(raw)
            target.chmod(0o644)
            hashes[name] = hashlib.sha256(raw).hexdigest()
        self.policy = {'source_hashes': hashes}
        self.pin = self.write_policy(self.policy)

    def write_policy(self, value):
        raw = (json.dumps(value, sort_keys=True) + '\n').encode()
        f = self.lib / 'approval.json'
        f.write_bytes(raw)
        f.chmod(0o644)
        return hashlib.sha256(raw).hexdigest()

    def verify(self, pin=None):
        return b.verify_bundle(self.lib, self.pin if pin is None else pin, owner=os.getuid())

    def test_all_eight_hashes_verified_before_code_is_loaded(self):
        policy, sources = self.verify()
        self.assertEqual(policy, self.policy)
        self.assertEqual(set(sources), set(b.FILES))
        self.assertTrue(all(sources[name] == (HERE / name).read_bytes() for name in b.FILES))

    def test_changed_source_never_reaches_execution(self):
        marker = self.lib / 'never-created'
        (self.lib / 'controller.py').write_text('from pathlib import Path; Path(' + repr(str(marker)) + ').write_text("bad")')
        with patch.object(b, 'verified_modules') as execute:
            with self.assertRaisesRegex(ValueError, 'before_import'):
                _, sources = self.verify()
                execute(sources, self.pin)
            execute.assert_not_called()
        self.assertFalse(marker.exists())

    def test_policy_changed_or_wrong_unit_pin_is_not_adopted(self):
        for pin in ['0' * 64, 'not-a-hash']:
            with self.subTest(pin=pin), self.assertRaises(ValueError):
                self.verify(pin)
        value = json.loads((self.lib / 'approval.json').read_bytes())
        value['approved_until_revoked'] = True
        self.write_policy(value)
        with self.assertRaisesRegex(ValueError, 'pinned_policy_hash_changed'):
            self.verify()

    def test_unexpected_cache_or_extra_file_refused(self):
        extra = self.lib / '__pycache__'
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, 'unexpected_binding_library_entry'):
            self.verify()
        extra.rmdir()
        extra = self.lib / 'unexpected.py'
        extra.write_text('raise RuntimeError("not loaded")')
        with self.assertRaisesRegex(ValueError, 'unexpected_binding_library_entry'):
            self.verify()

    def test_symlink_and_hardlink_source_not_loaded(self):
        target = self.lib / 'controller.py'
        target.unlink()
        target.symlink_to(HERE / 'controller.py')
        with self.assertRaises(OSError):
            self.verify()
        target.unlink()
        original = self.lib.parent / 'controller-copy'
        original.write_bytes((HERE / 'controller.py').read_bytes())
        original.chmod(0o644)
        os.link(original, target)
        with self.assertRaisesRegex(ValueError, 'protected_binding_file'):
            self.verify()

    def test_library_mode_and_source_mode_refused(self):
        self.lib.chmod(0o777)
        with self.assertRaises(ValueError):
            self.verify()
        self.lib.chmod(0o755)
        (self.lib / 'server.py').chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'protected_binding_file'):
            self.verify()

    def test_library_symlink_not_followed(self):
        alias = self.lib.parent / 'alias'
        alias.symlink_to(self.lib, target_is_directory=True)
        with self.assertRaises(OSError):
            b.verify_bundle(alias, self.pin, owner=os.getuid())

    def test_duplicate_policy_keys_are_rejected_before_any_module(self):
        raw = b'{"source_hashes":{},"source_hashes":{}}'
        (self.lib / 'approval.json').write_bytes(raw)
        with self.assertRaisesRegex(ValueError, 'duplicate_binding_policy_key'):
            self.verify(hashlib.sha256(raw).hexdigest())

    def test_missing_or_extra_source_hash_and_oversize_source_refused(self):
        changed = json.loads(json.dumps(self.policy))
        changed['source_hashes'].pop('server.py')
        self.pin = self.write_policy(changed)
        with self.assertRaisesRegex(ValueError, 'source_scope'):
            self.verify()
        self.pin = self.write_policy(self.policy)
        (self.lib / 'server.py').write_bytes(b'x' * 65537)
        with self.assertRaisesRegex(ValueError, 'protected_binding_file'):
            self.verify()

    def test_verified_buffers_are_used_even_if_disk_changes_later(self):
        _, sources = self.verify()
        (self.lib / 'controller.py').write_text('raise RuntimeError("unverified disk replacement must not execute")')
        with patch.dict(sys.modules, {}, clear=False):
            loaded = b.verified_modules(sources, self.pin)
            self.assertTrue(hasattr(loaded['controller'], 'Controller'))
            self.assertEqual(loaded['binding_runtime']._BOOT_POLICY_SHA256, self.pin)
            self.assertEqual(loaded['binding_client'].__file__, str(b.LIB / 'client.py'))
            self.assertIsNone(loaded['controller'].__cached__)
        self.assertFalse((self.lib / '__pycache__').exists())

    def test_entry_role_selects_only_fixed_verified_entry_and_injected_dependencies(self):
        modules = {'binding_runtime': types.SimpleNamespace(marker='runtime'),
                   'binding_client': types.SimpleNamespace(marker='client')}
        for role, expected in [('server', 'server.py'), ('broker', 'broker.py')]:
            source = b'raise RuntimeError((__file__, _BOOT_RUNTIME.marker, _BOOT_CLIENT.marker, _BOOT_POLICY["fixed"]))'
            sources = {'server.py': source, 'broker.py': source}
            with self.subTest(role=role), self.assertRaises(RuntimeError) as caught:
                b.execute_entry(role, sources, modules, {'fixed': True})
            self.assertEqual(caught.exception.args[0], (str(b.LIB / expected), 'runtime', 'client', True))

    def test_workspace_cannot_be_used_as_a_Root_bootstrap(self):
        with patch.object(b.os, 'geteuid', return_value=0), patch.object(b, 'verify_bundle') as verify:
            with self.assertRaisesRegex(ValueError, 'sealed_binding_bootstrap_entrypoint'):
                b.main()
            verify.assert_not_called()

    def test_uid_role_and_arguments_refused_before_policy_access(self):
        for argv, uid in [(['bootstrap', 'server', 'a' * 64], 1001),
                          (['bootstrap', 'broker', 'a' * 64], 0),
                          (['bootstrap', 'shell', 'a' * 64], 0),
                          (['bootstrap', 'server', 'a' * 64, '/free'], 0)]:
            with self.subTest(argv=argv, uid=uid), \
                    patch.object(b, '__file__', str(b.LIB / 'bootstrap.py')), \
                    patch.object(b.sys, 'argv', argv), \
                    patch.object(b.os, 'geteuid', return_value=uid), \
                    patch.object(b, 'verify_bundle') as verify:
                with self.assertRaises(ValueError):
                    b.main()
                verify.assert_not_called()


if __name__ == '__main__':
    unittest.main()
