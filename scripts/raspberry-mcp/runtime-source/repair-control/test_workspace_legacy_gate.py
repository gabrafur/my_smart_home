"""Synthetic legacy-send guards; no actual daemon, policy or operation store."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('workspace_legacy_send_gate',
 Path(__file__).parent.parent/'legacy-control/codex_control.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)


class LegacySendGate(unittest.TestCase):
 def test_denied_send_never_opens_store_or_invokes_RPC(self):
  args=dict(host='raspberry',thread_id=m.THREADS[0],operation_id='a'*32,intent='continue')
  for value in [False,None,0,'true']:
   with self.subTest(value=value),patch.object(m.os,'geteuid',return_value=1001),\
    patch.object(m,'plan',return_value={'allow_send':value}),patch.object(m,'Store')as store,\
    patch.object(m,'rpc')as rpc:
    with self.assertRaisesRegex(ValueError,'legacy_send_not_authorized'):
     m.handle('codex_thread_send',args)
    store.assert_not_called();rpc.assert_not_called()

 def test_metadata_observation_remains_available_when_send_is_disabled(self):
  for tool in ['codex_thread_read','codex_thread_status']:
   with self.subTest(tool=tool),patch.object(m.os,'geteuid',return_value=1001),\
    patch.object(m,'plan',return_value={'allow_send':False}),patch.object(m,'Store')as store,\
    patch.object(m,'rpc',return_value={'status':'notLoaded'})as rpc:
    out=m.handle(tool,{'host':'raspberry','thread_id':m.THREADS[0]})
    self.assertEqual(out['status'],'notLoaded');store.assert_not_called();rpc.assert_called_once()


if __name__=='__main__':unittest.main()
