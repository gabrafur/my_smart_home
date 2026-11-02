import datetime,importlib.util,json,socket,stat,struct,types,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('fixed_runtime_client',Path(__file__).with_name('runtime_client.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Conn:
 def __init__(self,uid=0,reply=None):self.uid=uid;self.sent=[];self.reply=reply or (json.dumps({'ok':True,'result':{'collection_error':None,'files':[],'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}})+'\n').encode()
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
class ObservationClockCases(unittest.TestCase):
 def test_original_source_clock_is_preserved_and_age_grows(self):
  at=datetime.datetime(2026,1,1,tzinfo=datetime.timezone.utc)
  result={'observed_at':at.isoformat(),'collection_error':None,'coverage':['upstream']}
  value=m.observation_metadata(result,at+datetime.timedelta(seconds=61))
  self.assertEqual(value['observed_at'],result['observed_at']);self.assertEqual(value['age_seconds'],61)
  self.assertEqual(value['source'],'fixed_NodeRED_readonly_socket');self.assertEqual(value['coverage'],['upstream'])
  self.assertNotIn('age_seconds',result)
 def test_future_clock_is_unknown_not_fresh(self):
  now=datetime.datetime(2026,1,1,tzinfo=datetime.timezone.utc)
  value=m.observation_metadata({'observed_at':(now+datetime.timedelta(seconds=1)).isoformat(),'collection_error':None},now)
  self.assertIsNone(value['age_seconds']);self.assertEqual(value['collection_error'],'clock_order_unconfirmed');self.assertEqual(value['state'],'unknown')
 def test_missing_or_naive_clock_not_replaced_with_call_time(self):
  now=datetime.datetime(2026,1,1,tzinfo=datetime.timezone.utc)
  for at in (None,'invalid','2026-01-01T00:00:00'):
   with self.subTest(at=at):
    value=m.observation_metadata({'observed_at':at,'collection_error':None},now)
    self.assertIsNone(value['age_seconds']);self.assertEqual(value['collection_error'],'source_time_unavailable');self.assertEqual(value['observed_at'],at)
 def test_explicit_source_and_error_remain_separate(self):
  now=datetime.datetime(2026,1,1,tzinfo=datetime.timezone.utc)
  value=m.observation_metadata({'source':'reviewed_source','observed_at':now.isoformat(),'collection_error':'existing_failure'},now)
  self.assertEqual(value['source'],'reviewed_source');self.assertEqual(value['collection_error'],'existing_failure');self.assertEqual(value['age_seconds'],0)
 def test_actual_failure_has_current_age_and_no_retry(self):
  value=Cases().run_request(Conn(reply=b'{"ok":false,"error":"runtime_collection_unavailable"}\n'))
  self.assertEqual(value['age_seconds'],0);self.assertEqual(value['reason_code'],'runtime_collection_unavailable');self.assertFalse(value['automatic_retry'])
if __name__=='__main__':unittest.main()
