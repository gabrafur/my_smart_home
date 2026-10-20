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
 def test_second_install_is_idempotent(self):
  cls=adapter.prepare_device_class(self.core,'2026.10.1');self.core.IcloudDevice=cls
  self.assertIs(adapter.prepare_device_class(self.core,'2026.10.1'),cls)
 def test_wrapper_wires_adapter_and_preserves_manual_auth(self):
  modules={}
  for name in ['homeassistant','homeassistant.components','homeassistant.components.icloud','homeassistant.const','homeassistant.exceptions','candidate','candidate.manual_auth','candidate.setup_retry']:
   modules[name]=types.ModuleType(name)
  pkg=modules['homeassistant.components.icloud'];pkg.account=self.core;pkg.config_flow=types.SimpleNamespace()
  pkg.CONFIG_SCHEMA=object();pkg.async_setup=object();pkg.async_unload_entry=object()
  async def fake_setup(hass,entry):return 'synthetic_setup'
  pkg.async_setup_entry=fake_setup
  modules['homeassistant.const'].__version__='2026.10.1'
  modules['homeassistant.exceptions'].ConfigEntryNotReady=type('ConfigEntryNotReady',(Exception,),{})
  class ManualOtpService:
   def __init__(self,*args,**kwargs):raise AssertionError('account_access_forbidden')
  modules['candidate.manual_auth'].ManualOtpService=ManualOtpService
  modules['candidate.setup_retry'].is_transport_failure=lambda exc:False
  modules['candidate.device_owner']=adapter
  namespace={'__name__':'candidate','__package__':'candidate'}
  with patch.dict(sys.modules,modules):exec(compile((ROOT.parent/'custom_components/icloud/__init__.py').read_text(),'<candidate_wrapper>','exec'),namespace)
  self.assertTrue(issubclass(self.core.IcloudDevice,native.IcloudDevice))
  self.assertIs(self.core.PyiCloudService,ManualOtpService);self.assertIs(pkg.config_flow.PyiCloudService,ManualOtpService)
  self.assertIs(namespace['async_unload_entry'],pkg.async_unload_entry)
if __name__=='__main__':unittest.main()
