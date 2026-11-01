"""The read-side inventory must cover all four already admitted registrations."""
import hashlib,json,sqlite3,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import initial_host_contract as c
class InventoryTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);(self.root/'registrations').mkdir()
  db=sqlite3.connect(self.root/'workflow.sqlite3');db.execute('CREATE TABLE operations(id TEXT,state TEXT,result TEXT)');db.execute('CREATE TABLE receipts(seq INTEGER PRIMARY KEY,id TEXT,state TEXT,result TEXT,result_hash TEXT,at REAL)');db.close()
  for p in [patch.object(c,'protected_dir',side_effect=Path),patch.object(c,'read',side_effect=lambda p,*a,**k:Path(p).read_bytes()),patch.object(c,'_root_json',side_effect=lambda p,*a,**k:json.loads(Path(p).read_bytes()))]:p.start();self.addCleanup(p.stop)
 def add(self,n):
  op=('%x'%n)*32;row={'schema_version':1,'identity':{'operation_id':op,'task_id':'a'*32,'send_id':'b'*32,'proposal_id':'c'*32},'request_sha256':'d'*64,'state':'intent','created_at':1,'result':None};(self.root/'registrations'/(op+'.json')).write_text(json.dumps(row))
 def test_fourth_registration_remains_observable(self):
  for n in range(1,5):self.add(n)
  out=c.registration_registry(self.root,lambda:10);self.assertEqual(out['records'],4);self.assertFalse(out['truncated']);self.assertEqual(out['collection_error'],'registration_intent_requires_reconciliation')
 def test_registered_released_result_is_projected_from_receipts(self):
  self.add(1);op='1'*32;path=self.root/'registrations'/(op+'.json');row=json.loads(path.read_text())
  (self.root/'requests').mkdir();(self.root/'proposals').mkdir()
  request={key:None for key in c.ROOT_REQUEST_FIELDS};proposal=b'proposal'
  (self.root/'requests'/(op+'.json')).write_text(json.dumps(request));(self.root/'proposals'/('c'*32+'.json')).write_bytes(proposal)
  row.update(state='registered',result={'operation_id':op,'expires_at':99,'request_sha256':c.sha(c.raw(request)),'proposal_sha256':c.sha(proposal)});path.write_text(json.dumps(row))
  result={'definitive_no_effect':True,'private_error':'sensitive'};encoded=json.dumps(result,sort_keys=True,separators=(',',':'));digest=hashlib.sha256(encoded.encode()).hexdigest()
  db=sqlite3.connect(self.root/'workflow.sqlite3');db.execute('INSERT INTO operations VALUES(?,?,?)',(op,'released',json.dumps(result)))
  db.execute('INSERT INTO receipts(id,state,result,result_hash,at) VALUES(?,?,?,?,?)',(op,'failed_without_effect',encoded,digest,4));db.execute('INSERT INTO receipts(id,state,result,result_hash,at) VALUES(?,?,?,?,?)',(op,'released',encoded,digest,7));db.commit();db.close()
  record=c.registration_registry(self.root,lambda:10)['requests'][0]
  self.assertEqual((record['workflow_state'],record['terminal_result'],record['terminal_result_at']),('released','failed_without_effect',4));self.assertNotIn('sensitive',json.dumps(record))
 def test_fifth_registration_still_fails_closed(self):
  for n in range(1,6):self.add(n)
  with self.assertRaisesRegex(ValueError,'capacity_changed'):c.registration_registry(self.root,lambda:10)
class TerminalObservationTests(unittest.TestCase):
 def receipt(self,state,result,at=5):
  encoded=json.dumps(result,sort_keys=True,separators=(',',':'))
  return (state,encoded,hashlib.sha256(encoded.encode()).hexdigest(),at)
 def test_released_results_preserve_terminal_time_and_private_fields_stay_private(self):
  for state,result in [('verified',{'functional_proof':True,'security_cleanup_confirmed':True}),('failed_without_effect',{'definitive_no_effect':True,'private_error':'sensitive'}),('confirmed_not_applied',{'definitive_no_dispatch':True}),('rolled_back',{'functional_recovery_proven':False})]:
   with self.subTest(state=state):
    terminal=self.receipt(state,result,4);released=self.receipt('released',result,7)
    observation=c.terminal_observation('released',json.dumps(result),[released,terminal],10)
    self.assertEqual(observation,(state,4));self.assertNotIn('sensitive',str(observation))
 def test_missing_mismatched_and_corrupt_receipts_are_unknown(self):
  result={'security_cleanup_confirmed':True};terminal=self.receipt('verified',result);released=self.receipt('released',result,6)
  cases=[[],[released],[released,self.receipt('verified',{'other':True})],[(released[0],released[1],'0'*64,released[3]),terminal],[released,('verified','{',terminal[2],4)],[released,self.receipt('uncertain',result)], [released,terminal]]
  for i,rows in enumerate(cases):
   with self.subTest(case=i):self.assertEqual(c.terminal_observation('released',json.dumps({'other':True} if i==6 else result),rows,10),('unknown',None))
 def test_invalid_times_and_oversized_results_are_unknown(self):
  result={'safe':True};terminal=self.receipt('verified',result)
  for at in [float('nan'),float('inf'),-1,11]:
   with self.subTest(at=at):self.assertEqual(c.terminal_observation('verified',json.dumps(result),[self.receipt('verified',result,at)],10),('unknown',None))
  self.assertEqual(c.terminal_observation('released',json.dumps(result),[self.receipt('released',result,4),terminal],10),('unknown',None))
  large={'data':'x'*16384};self.assertEqual(c.terminal_observation('verified',json.dumps(large),[self.receipt('verified',large)],10),('unknown',None))
 def test_nonterminal_and_direct_terminal(self):
  result={'safe':True};self.assertEqual(c.terminal_observation('uncertain',None,[],10),('not_terminal',None))
  self.assertEqual(c.terminal_observation('verified',json.dumps(result),[self.receipt('verified',result)],10),('verified',5))

if __name__=='__main__':unittest.main()
