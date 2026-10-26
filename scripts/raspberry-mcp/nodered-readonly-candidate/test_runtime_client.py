import importlib.util,json,socket,stat,struct,types,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('fixed_runtime_client',Path(__file__).with_name('runtime_client.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Conn:
 def __init__(self,uid=0,reply=None):self.uid=uid;self.sent=[];self.reply=reply or b'{"ok":true,"result":{"collection_error":null,"files":[]}}\n'
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def settimeout(self,t):pass
 def connect(self,p):pass
 def getsockopt(self,*a):return struct.pack('3i',1,self.uid,0)
 def sendall(self,b):self.sent.append(b)
 def recv(self,n):r,self.reply=self.reply,b'';return r
class Cases(unittest.TestCase):
 def run_request(self,conn,owner=1001,mode=0o600):
  sock=types.SimpleNamespace(lstat=lambda:types.SimpleNamespace(st_mode=stat.S_IFSOCK|mode,st_uid=owner),__str__=lambda s:'/fixed')
  with patch.object(m,'SOCKET',sock),patch.object(m.socket,'socket',return_value=conn):return m.files()
 def test_systemd_root_listener_with_user_DAC_is_expected(self):
  c=Conn();r=self.run_request(c);self.assertIsNone(r['collection_error']);self.assertEqual(len(c.sent),1);self.assertEqual(json.loads(c.sent[0]),{'op':'files','host':'raspberry','offset':0})
 def test_unrelated_listener_is_refused_before_send(self):
  c=Conn(1002);self.assertTrue(self.run_request(c)['collection_error']);self.assertEqual(c.sent,[])
 def test_warm_node_listener_UID1001_is_expected(self):
  c=Conn(1001);r=self.run_request(c);self.assertIsNone(r['collection_error']);self.assertEqual(len(c.sent),1)
 def test_allowlisted_reason_is_available_but_private_errors_withheld(self):
  c=Conn(reply=b'{"ok":false,"error":"collection_cooldown"}\n');self.assertEqual(self.run_request(c)['reason_code'],'collection_cooldown')
 def test_wrong_inode_owner_is_refused_before_send(self):
  c=Conn();self.assertTrue(self.run_request(c,owner=0)['collection_error']);self.assertEqual(c.sent,[])
 def test_world_readable_socket_is_refused(self):
  c=Conn();self.assertTrue(self.run_request(c,mode=0o666)['collection_error']);self.assertEqual(c.sent,[])
 def test_unknown_result_is_collection_error_without_retry(self):
  c=Conn(reply=b'{"ok":false,"error":"PRIVATE_ERROR"}\n');r=self.run_request(c);self.assertTrue(r['collection_error']);self.assertNotIn('PRIVATE',json.dumps(r));self.assertEqual(len(c.sent),1)
 def test_multiple_messages_refused(self):
  c=Conn(reply=b'{}\n{}\n');self.assertTrue(self.run_request(c)['collection_error']);self.assertEqual(len(c.sent),1)
 def test_read_invalid_target_and_path_arguments_refused(self):
  for q in ({'host':'other','file_id':'a'*32,'offset':0},{'host':'raspberry','file_id':'/etc/passwd','offset':0},{'host':'raspberry','file_id':'a'*32,'offset':0,'path':'/etc/passwd'}):self.assertRaises(ValueError,m.read,q)
 def test_bool_offset_refused(self):self.assertRaises(ValueError,m.read,{'host':'raspberry','file_id':'a'*32,'offset':False})
if __name__=='__main__':unittest.main()
