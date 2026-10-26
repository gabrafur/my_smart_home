import contextlib,hashlib,importlib.util,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).parent
s=importlib.util.spec_from_file_location('isolated_fixed_upgrade',P/'upgrade.template.py');u=importlib.util.module_from_spec(s);s.loader.exec_module(u)
def b(v):return json.dumps(v).encode()
class RecoveryTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=Path(self.tmp.name);self.state=self.p/'state';self.state.mkdir();(self.state/'before').mkdir();self.t={n:self.p/n for n in ['a','b','c']};self.writes=[];self.commands=[];self.m={'operation_id':'a'*32,'expected_image':'image','targets':{n:{'before':u.sha(b'before-'+n.encode()),'after':u.sha(b'after-'+n.encode()),'uid':0,'gid':0,'mode':0o600}for n in self.t}};self.row={'activation_attempted':False,'services_before':{n:{'started_at':'old'}for n in u.SERVICES},'identities_before':{'registry':['id'],'recorder':{'inode':1}}};self.ss={n:{'started_at':'old','running':True,'health':'healthy','image':'image'}for n in u.SERVICES}
  for n,p in self.t.items():p.write_bytes(b'after-'+n.encode());(self.state/'before'/n).write_bytes(b'before-'+n.encode())
  (self.state/'receipt.json').write_bytes(b(self.row))
  self.enterContext(patch.object(u,'STATE',self.state));self.enterContext(patch.object(u,'TARGETS',self.t));self.enterContext(patch.object(u,'gate',lambda:None));self.enterContext(patch.object(u,'load',lambda:(self.m,{})))
  self.enterContext(patch.object(u,'read',lambda p,*a,**k:p.read_bytes()))
  h=types.SimpleNamespace(chains=lambda:None,locks=lambda t:contextlib.nullcontext(),root_backend=lambda:None)
  self.enterContext(patch.object(u,'helper',lambda:h));self.enterContext(patch.object(u,'services',lambda:self.ss));self.enterContext(patch.object(u,'save',lambda row:self.row.update(row)));self.enterContext(patch.object(u,'sync',lambda p:None));self.enterContext(patch.object(u,'run',lambda argv,*a:self.commands.append(argv)))
  def atomic(p,data,*args,**kw):self.writes.append(p);p.write_bytes(data)
  self.enterContext(patch.object(u,'atomic',atomic))
 def test_partial_install_restores_known_after_and_preserves_before(self):
  self.t['a'].write_bytes(b'before-a');(self.state/'before'/'a').unlink()
  u.main('rollback');self.assertEqual([p.read_bytes()for p in self.t.values()],[b'before-a',b'before-b',b'before-c']);self.assertEqual(self.commands,[])
 def test_unknown_external_target_prevents_all_restoration(self):
  self.t['c'].write_bytes(b'external');self.assertRaisesRegex(ValueError,'unknown_target',u.main,'rollback');self.assertEqual(self.writes,[]);self.assertEqual(self.t['a'].read_bytes(),b'after-a')
 def test_corrupt_last_backup_prevents_any_restoration(self):
  (self.state/'before'/'c').write_bytes(b'corrupt');self.assertRaisesRegex(ValueError,'rollback_backup_changed',u.main,'rollback');self.assertEqual(self.writes,[])
 def test_rollback_intent_prevents_uncertain_restart_retry(self):
  (self.state/'rollback-intent.json').write_bytes(b'{}');self.assertRaisesRegex(ValueError,'requires_reconciliation',u.main,'rollback');self.assertEqual(self.commands,[])
 def test_reconciled_activation_gets_one_separate_rollback_restart(self):
  self.row['activation_attempted']=True;(self.state/'receipt.json').write_bytes(b(self.row));self.ss['homeassistant']['started_at']='new';u.main('rollback');self.assertEqual(len(self.commands),1);self.assertEqual(self.row['rollback_services_restarted'],1)
 def test_unconfirmed_stopped_HA_requires_reconciliation(self):
  self.row['activation_attempted']=True;(self.state/'receipt.json').write_bytes(b(self.row));self.ss['homeassistant']['running']=False;self.assertRaisesRegex(ValueError,'HA_state_requires_reconciliation',u.main,'rollback');self.assertEqual(self.writes,[])
 def test_external_HA_restart_does_not_admit_rollback_restart(self):
  self.ss['homeassistant']['started_at']='external';self.assertRaisesRegex(ValueError,'external_HA_restart',u.main,'rollback');self.assertEqual(self.commands,[])
 def test_other_service_restart_stops_before_source_changes(self):
  self.ss['nodered']['started_at']='external';self.assertRaisesRegex(ValueError,'other_service_changed',u.main,'rollback');self.assertEqual(self.writes,[])
 def test_before_absent_known_new_file_removed(self):
  self.m['targets']['c']['before']=None;u.main('rollback');self.assertFalse(self.t['c'].exists())
 def test_before_absent_and_still_missing_is_noop(self):
  self.m['targets']['c']['before']=None;self.t['c'].unlink();u.main('rollback');self.assertFalse(self.t['c'].exists())
if __name__=='__main__':unittest.main()
