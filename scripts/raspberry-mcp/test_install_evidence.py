import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install-evidence.py'))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        for name in ('source','base','app','units','units/raspberry-mcp@.service.d'):(self.root/name).mkdir(parents=True,exist_ok=True)
        self.patches=[]
        for key,value in {'SOURCE':self.root/'source','BASE':self.root/'base','APP':self.root/'app','UNITS':self.root/'units',
          'FRONT_DROP':self.root/'units/raspberry-mcp@.service.d/90-evidence.conf',
          'BROKER_DROP':self.root/'units/raspberry-mcp-operations@.service.d/90-evidence.conf'}.items():
            p=patch.object(installer,key,value);p.start();self.addCleanup(p.stop)
        self.safe=patch.object(installer,'safe_directory');self.safe.start();self.addCleanup(self.safe.stop)
        self.run=patch.object(installer,'run');self.mock_run=self.run.start();self.addCleanup(self.run.stop)
        def fake_sha(path):
            return (installer.NEW_HASHES if path.parent==installer.SOURCE else installer.OLD_HASHES)[path.name]
        self.hash=patch.object(installer,'sha',side_effect=fake_sha);self.hash.start();self.addCleanup(self.hash.stop)
    def test_preflight_is_read_only(self):
        before=sorted(str(p) for p in self.root.rglob('*'))
        self.assertEqual(len(installer.preflight()),5)
        self.assertEqual(before,sorted(str(p) for p in self.root.rglob('*')))
        self.assertEqual(self.mock_run.call_args.args,('systemctl','is-active','--quiet','raspberry-mcp-tunnel.service','raspberry-mcp-operations.socket'))
    def test_changed_hash_rejected(self):
        with patch.object(installer,'sha',return_value='bad'):
            with self.assertRaisesRegex(RuntimeError,'reviewed_source_changed'):installer.preflight()
        self.mock_run.assert_not_called()
    def test_existing_install_not_overwritten(self):
        (installer.BASE/'maintenance_evidence.py').write_text('existing')
        with self.assertRaisesRegex(RuntimeError,'already_present'):installer.preflight()
        self.assertEqual((installer.BASE/'maintenance_evidence.py').read_text(),'existing')
    def test_dangling_symlink_rejected(self):
        installer.FRONT_DROP.symlink_to(self.root/'missing')
        with self.assertRaisesRegex(RuntimeError,'already_present'):installer.preflight()
    def test_check_stops_before_writes(self):
        with patch.object(installer.sys,'argv',['installer','--check']), patch.object(installer.os,'geteuid',side_effect=AssertionError('no privilege check needed')):
            installer.main()

if __name__=='__main__':unittest.main()
