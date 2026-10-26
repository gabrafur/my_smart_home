import importlib.util,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('activation',Path(__file__).with_name('activate.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class Activation(unittest.TestCase):
 def test_preflight_never_writes_permission(self):
  g=types.SimpleNamespace(ORIGINAL_RECEIPT='a'*64)
  with patch.object(a.os,'geteuid',return_value=0),patch.object(a,'__file__',str(a.BASE/'activate.py')),patch.object(a.sys,'argv',['activate.py','preflight']),patch.object(a,'checked',return_value=('b'*64,g)),patch.object(a.os,'open')as opened:
   out=a.main();self.assertTrue(out['specific_approval_required']);opened.assert_not_called()
 def test_approved_marker_is_exclusive_and_bound(self):
  g=types.SimpleNamespace(ORIGINAL_RECEIPT='a'*64,approval=lambda pin:None)
  with tempfile.TemporaryDirectory()as tmp:
   base=Path(tmp)
   with patch.object(a,'BASE',base),patch.object(a.os,'geteuid',return_value=0),patch.object(a,'__file__',str(base/'activate.py')),patch.object(a.sys,'argv',['activate.py','apply-approved']),patch.object(a,'checked',return_value=('b'*64,g)):
    out=a.main();self.assertFalse(out['new_MCP_access']);before=(base/'RECOVERY-APPROVAL.json').read_bytes();marker=json.loads(before);self.assertEqual(marker['operation_id'],a.OP);self.assertEqual(marker['additional_key_reads'],1);self.assertEqual(marker['expires_at'],a.EXPIRY)
    with self.assertRaises(FileExistsError):a.main()
    self.assertEqual((base/'RECOVERY-APPROVAL.json').read_bytes(),before)
 def test_free_arguments_do_not_activate(self):
  with patch.object(a.os,'geteuid',return_value=0),patch.object(a,'__file__',str(a.BASE/'activate.py')),patch.object(a.sys,'argv',['activate.py','apply-approved','arbitrary']),patch.object(a,'checked')as check:
   with self.assertRaises(ValueError):a.main()
   check.assert_not_called()
if __name__=='__main__':unittest.main()
