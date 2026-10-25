import asyncio,importlib.util,pathlib,sys,types,unittest
from unittest.mock import patch
import icloud_native_fixture as native
spec=importlib.util.spec_from_file_location('device_owner_under_test',pathlib.Path(__file__).resolve().parents[1]/'custom_components/icloud/device_owner.py')
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
ROOT=pathlib.Path(__file__).parent
class AdapterTests(unittest.TestCase):
 def setUp(self):
  self.core=types.SimpleNamespace(**{name:getattr(native,name) for name in dir(native) if not name.startswith('__')})
  self.account=types.SimpleNamespace(fetch_interval=30,family_members_fullname={},owner_fullname='SYNTHETIC_ACCOUNT')
  self.status={getattr(native,n):'SYNTHETIC_'+n for n in ('DEVICE_NAME','DEVICE_ID','DEVICE_CLASS','DEVICE_DISPLAY_NAME','DEVICE_PERSON_ID')}
  guard=patch('socket.socket',side_effect=AssertionError('network_forbidden'));guard.start();self.addCleanup(guard.stop)
 def make(self):return adapter.prepare_device_class(self.core,'2026.10.1')(self.account,object(),self.status)
 def test_missing_member_constructs_without_false_owner(self):
  obj=self.make();self.assertNotIn(native.ATTR_OWNER_NAME,obj._attrs);self.assertEqual(obj._device_id,self.status[native.DEVICE_ID])
 def test_known_member_preserved(self):
  self.account.family_members_fullname[self.status[native.DEVICE_PERSON_ID]]='SYNTHETIC_MEMBER'
  self.assertEqual(self.make()._attrs[native.ATTR_OWNER_NAME],'SYNTHETIC_MEMBER')
 def test_absent_person_field_unknown(self):
  del self.status[native.DEVICE_PERSON_ID];self.assertNotIn(native.ATTR_OWNER_NAME,self.make()._attrs)
 def test_unrelated_required_field_error_not_swallowed(self):
  del self.status[native.DEVICE_ID]
  with self.assertRaises(KeyError):self.make()
 def test_native_update_unchanged(self):
  cls=adapter.prepare_device_class(self.core,'2026.10.1')
  self.assertIs(cls.update,native.IcloudDevice.update);self.assertTrue(issubclass(cls,native.IcloudDevice))
 def test_version_drift_rejected(self):
  with self.assertRaisesRegex(RuntimeError,'unsupported_icloud_core_version'):adapter.prepare_device_class(self.core,'2026.10.2')
 def test_constructor_drift_rejected(self):
  class Changed:
   def __init__(self):pass
  self.core.IcloudDevice=Changed
  with self.assertRaisesRegex(RuntimeError,'icloud_constructor_changed'):adapter.prepare_device_class(self.core,'2026.10.1')
 def test_reviewed_patch_accepts_same_constructor(self):
  cls=adapter.prepare_device_class(self.core,'2026.10.4')
  self.assertIs(cls.update,native.IcloudDevice.update)
  self.assertNotIn(native.ATTR_OWNER_NAME,cls(self.account,object(),self.status)._attrs)
 def test_next_unreviewed_patch_still_rejected(self):
  with self.assertRaisesRegex(RuntimeError,'unsupported_icloud_core_version'):adapter.prepare_device_class(self.core,'2026.10.5')
 def test_reviewed_patch_constructor_drift_still_rejected(self):
  class Changed:
   def __init__(self):pass
  self.core.IcloudDevice=Changed
  with self.assertRaisesRegex(RuntimeError,'icloud_constructor_changed'):adapter.prepare_device_class(self.core,'2026.10.4')
 def test_second_install_is_idempotent(self):
  cls=adapter.prepare_device_class(self.core,'2026.10.1');self.core.IcloudDevice=cls
  self.assertIs(adapter.prepare_device_class(self.core,'2026.10.1'),cls)
 def test_wrapper_wires_adapter_and_preserves_manual_auth(self):
  from test_icloud_manual_auth import loaded_adapter
  with loaded_adapter() as env:
   self.assertTrue(issubclass(env.account.IcloudDevice,native.IcloudDevice))
   self.assertIs(env.account.PyiCloudService,env.sut.GuardedService)
   self.assertIs(env.alias.ManualOtpService,env.sut.GuardedService)
   self.assertIs(env.handlers['icloud'],env.flow)
   # Unload is now guarded: a waiting entry has no platforms to unload.
   self.assertIsNot(env.sut.async_unload_entry,env.core.async_unload_entry)
if __name__=='__main__':unittest.main()
