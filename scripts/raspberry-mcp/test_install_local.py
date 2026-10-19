import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import subprocess
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-local.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_requires_interactive_sudo_without_mutations(self):
        with patch.object(installer.os, 'geteuid', return_value=1001), patch.object(installer, 'run') as run:
            with self.assertRaises(SystemExit):
                installer.main()
            run.assert_not_called()

    def test_rejects_missing_operator_without_mutations(self):
        with patch.object(installer.os, 'geteuid', return_value=0), patch.dict(installer.os.environ, {}, clear=True), patch.object(installer, 'run') as run:
            with self.assertRaises(SystemExit):
                installer.main()
            run.assert_not_called()

    def test_debian_minimatch_is_copied(self):
        self.assertIn('minimatch', installer.BUILTINS)

    def test_failed_probe_reports_bounded_diagnostic(self):
        error = subprocess.CalledProcessError(-6, ['chroot'], stderr='missing builtin ' + 'x' * 3000)
        with patch.object(installer.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1234)), \
             patch.object(installer.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=1234)), \
             patch.object(installer, 'run', side_effect=error) as run:
            with self.assertRaises(SystemExit) as failure:
                installer.isolation_probe()
            self.assertIn('missing builtin', str(failure.exception))
            self.assertLess(len(str(failure.exception)), 2100)
            self.assertEqual(run.call_args.kwargs['timeout'], 15)

    def test_resume_rejects_existing_unit_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            units = Path(directory)
            (units / 'test.service').write_text('synthetic')
            with patch.object(installer, 'UNIT_DIR', units):
                with self.assertRaisesRegex(SystemExit, 'units already exist'):
                    installer.validate_partial(['test.service'])
            (units / 'link').symlink_to(units, target_is_directory=True)
            with patch.object(installer, 'UNIT_DIR', units), patch.object(installer, 'BASE', units / 'link'):
                with self.assertRaisesRegex(SystemExit, 'Unexpected partial'):
                    installer.validate_partial([])

    def test_manifest_and_activation_keep_tunnel_and_household_untouched(self):
        created = set()
        calls, writes = [], {}

        def account(name):
            if name == 'synthetic_operator' or name in created:
                return SimpleNamespace(pw_uid=1234, pw_gid=1234)
            raise KeyError(name)

        def run(*args, **kwargs):
            calls.append(args)
            if args[0] == 'useradd':
                created.add(args[-1])
            return SimpleNamespace(stdout='{"result":{"tools":[1,2,3,4,5]}}' if args[0] == 'chroot' else '')

        with patch.object(installer.os, 'geteuid', return_value=0), patch.dict(installer.os.environ, {'SUDO_USER':'synthetic_operator'}, clear=True), \
             patch.object(installer.pwd, 'getpwnam', side_effect=account), patch.object(installer.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=1234)), \
             patch.object(installer.os, 'getgrouplist', return_value=[1234]), patch.object(installer.Path, 'exists', return_value=False), \
             patch.object(installer.Path, 'is_file', return_value=True), patch.object(installer.Path, 'is_dir', return_value=False), \
             patch.object(installer.Path, 'mkdir'), patch.object(installer.Path, 'chmod'), patch.object(installer.shutil, 'copyfile'), \
             patch.object(installer.shutil, 'copy2'), patch.object(installer, 'run', side_effect=run), \
             patch.object(installer, 'write', side_effect=lambda p,t: writes.update({str(p):t})):
            installer.main()
        service = writes['/etc/systemd/system/raspberry-mcp@.service']
        for setting in ['PrivateNetwork=yes','NoNewPrivileges=yes','CapabilityBoundingSet=','ProtectSystem=strict','RootDirectory=', 'MemoryMax=64M']:
            self.assertIn(setting, service)
        socket = writes['/etc/systemd/system/raspberry-mcp.socket']
        self.assertIn('SocketMode=0660', socket)
        self.assertIn('ListenStream=/run/raspberry-mcp/mcp.sock', socket)
        self.assertFalse(any('restart' in c or 'reboot' in c or 'curl' in c or 'tunnel-client' in c for c in calls))
        for command in calls:
            if command[0] == 'systemctl':
                self.assertTrue(all(x.startswith('raspberry-mcp') for x in command[2:] if not x.startswith('--')))


if __name__ == '__main__':
    unittest.main()
