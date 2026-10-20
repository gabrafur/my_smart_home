import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('operations', Path(__file__).with_name('operations.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'project'
        self.state = Path(self.temp.name) / 'state'
        self.state.mkdir()
        (self.root / 'docs').mkdir(parents=True)
        self.file = self.root / 'docs/EXAMPLE.md'
        self.file.write_text('public example\n')
        self.key = 'a' * 32
        self.catalog = {self.key: {'path':'docs/EXAMPLE.md','sha256':ops.digest(self.file.read_bytes())}}
        self.calls=[]
        self.broker=ops.Broker(self.root,self.state,self.catalog,lambda service:self.calls.append(service) or True)
    def tearDown(self):
        self.temp.cleanup()
    def call(self,name,**args):
        return self.broker.handle(name,dict(host='raspberry',**args))
    def prepare(self):
        return self.call('project_prepare_edit',file_id=self.key,expected_sha256=self.catalog[self.key]['sha256'],old_text='example',new_text='updated')['change_id']
    def test_file_apply_is_intentionally_unavailable_without_effects(self):
        change=self.prepare()
        before=self.file.read_bytes()
        state_before={p.name:p.read_bytes() for p in self.state.iterdir()}
        with self.assertRaisesRegex(ValueError,'atomic_compare_replace_unavailable'):
            self.call('change_apply',change_id=change)
        self.assertEqual(self.file.read_bytes(),before)
        self.assertEqual({p.name:p.read_bytes() for p in self.state.iterdir()},state_before)
        self.assertEqual(list(self.file.parent.iterdir()),[self.file])
        self.assertEqual(self.call('project_read',file_id=self.key,offset=0)['text'],before.decode())
        self.assertFalse(self.calls)
    def test_conflicting_local_edit_preserved(self):
        change=self.prepare()
        self.file.write_text('someone else\n')
        with self.assertRaisesRegex(ValueError,'local_changes_detected'):
            self.call('change_apply',change_id=change)
        self.assertEqual(self.file.read_text(),'someone else\n')
    def test_unlisted_path_and_extra_fields_denied(self):
        for path in ('../docs/a.md','/etc/passwd','docs/../secret.md','docs/.env','scripts/raspberry-mcp/operations.py','nodered/flows_cred.json','homeassistant/secrets.yaml'):
            self.assertFalse(ops.allowed(path))
        with self.assertRaises(ValueError):self.call('project_read',file_id='b'*32,offset=0)
        with self.assertRaises(ValueError):self.call('project_read',file_id=self.key,offset=0,path='/etc/passwd')
        with self.assertRaises(ValueError):self.broker.handle('project_read',dict(host='other',file_id=self.key,offset=0))
    def test_symlink_and_hardlink_denied(self):
        self.file.unlink()
        self.file.symlink_to('/etc/passwd')
        with self.assertRaises(OSError):self.call('project_read',file_id=self.key,offset=0)
        self.file.unlink()
        outside=Path(self.temp.name)/'outside'
        outside.write_text('public example\n')
        os.link(outside,self.file)
        with self.assertRaisesRegex(ValueError,'file_not_supported'):self.call('project_read',file_id=self.key,offset=0)
    def test_parent_symlink_denied(self):
        self.file.unlink()
        self.file.parent.rmdir()
        self.file.parent.symlink_to(self.state,target_is_directory=True)
        with self.assertRaises(OSError):self.call('project_read',file_id=self.key,offset=0)
    def test_secret_payload_and_ambiguous_replacement_denied(self):
        for replacement in ('token: '+ 'x'*25,'-----BEGIN PRIVATE KEY-----'):  # PRIVACY_TEST_FIXTURE: synthetic header only; no key material
            with self.assertRaisesRegex(ValueError,'sensitive_content_blocked'):
                self.call('project_prepare_edit',file_id=self.key,expected_sha256=self.catalog[self.key]['sha256'],old_text='example',new_text=replacement)
        with self.assertRaises(ValueError):self.call('project_prepare_edit',file_id=self.key,expected_sha256='0'*64,old_text='example',new_text='new')
    def test_restart_fixed_target_once_and_no_undo(self):
        with self.assertRaises(ValueError):self.call('service_prepare_restart',service='$(touch /tmp/bad)')
        key=self.call('service_prepare_restart',service='nodered')['change_id']
        self.assertFalse(self.calls)
        self.call('change_apply',change_id=key)
        self.call('change_apply',change_id=key)
        self.assertEqual(self.calls,['nodered'])
        with self.assertRaises(ValueError):self.call('change_revert',change_id=key)
    def test_unknown_restart_not_retried(self):
        self.broker.restart_fn=lambda service:False
        key=self.call('service_prepare_restart',service='homeassistant')['change_id']
        self.assertEqual(self.call('change_apply',change_id=key)['status'],'outcome_unknown')
        with self.assertRaises(ValueError):self.call('change_apply',change_id=key)
    def test_expired_and_bad_offsets(self):
        key=self.prepare()
        row=self.broker.load('change-'+key+'.json')
        row['created_at']=0
        self.broker.save('change-'+key+'.json',row)
        with self.assertRaises(ValueError):self.call('change_apply',change_id=key)
        for offset in (-1,True,300000):
            with self.assertRaises(ValueError):self.call('project_read',file_id=self.key,offset=offset)

if __name__=='__main__':unittest.main()
