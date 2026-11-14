import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch


class Tests(unittest.TestCase):
    def test_local_import_requires_no_desktop_configuration_or_connection(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'scripts').mkdir()
            (root/'.local-secrets').mkdir()
            (root/'.local-secrets/rollback-cloud-daily.json').write_text(json.dumps({'allow_existing_pc_fallback':False}))
            source=Path(__file__).with_name('rollback_cloud_transport.py')
            target=root/'scripts/rollback_cloud_transport.py'
            shutil.copyfile(source,target)
            spec=importlib.util.spec_from_file_location('local_transport_test',target)
            module=importlib.util.module_from_spec(spec)
            with patch('subprocess.Popen',side_effect=AssertionError('unexpected connection')):
                spec.loader.exec_module(module)
            self.assertFalse((root/'.local-state').exists())
            self.assertIsNone(module.PC_ROOT)
            self.assertFalse(module.POLICY['allow_existing_pc_fallback'])

    def test_existing_desktop_transport_is_checked_only_when_requested(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'scripts').mkdir()
            (root/'.local-secrets').mkdir()
            (root/'.local-secrets/rollback-cloud-daily.json').write_text('{}')
            target=root/'scripts/rollback_cloud_transport.py'
            shutil.copyfile(Path(__file__).with_name('rollback_cloud_transport.py'),target)
            spec=importlib.util.spec_from_file_location('optional_transport_test',target)
            module=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with self.assertRaises(ValueError):
                module.desktop_transport()

if __name__=='__main__':
    unittest.main()
