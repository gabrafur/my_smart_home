import importlib.util, pathlib, unittest
p=pathlib.Path(__file__).with_name('consume.py');spec=importlib.util.spec_from_file_location('bridge',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Transport(unittest.TestCase):
 def setUp(self):
  self.files={};self.original_read=m.read;self.original_atomic=m.atomic
  m.read=lambda path,*args,**kwargs:self.files.get(path)
  m.atomic=lambda path,body:self.files.__setitem__(path,body)
  self.addCleanup(setattr,m,'read',self.original_read);self.addCleanup(setattr,m,'atomic',self.original_atomic)
  self.role=m.ROLES[0]
 def event(self,content=None):
  if content is None:content=m.encoded({'schema_version':1,'notification_id':m.target_for(self.role).stem,'title':'incident','message':'technical detail','created_at':'2026-11-15T00:00:00Z'})
  e={'sequence':1,'previous_revision':None,'content':content,'enqueued_at':'2026-11-15T00:00:00.000Z'};e['revision']=m.digest(m.encoded([self.role,1,None,content,e['enqueued_at']]));return e
 def ledger(self,e):return {'schema_version':1,'roles':{},'history':[],'pending':{'role':self.role,'event':e,'before':None}}
 def test_closed_notice(self):m.validate_event(self.role,self.event())
 def test_foreign_identifier(self):
  e=self.event(self.event()['content'].replace('eva_private_native_systemd_procmon','eva_private_arbitrary'))
  with self.assertRaisesRegex(ValueError,'notice_identity'):m.validate_event(self.role,e)
 def test_revision_tamper(self):
  e=self.event();e['sequence']=2
  with self.assertRaisesRegex(ValueError,'revision'):m.validate_event(self.role,e)
 def test_effect_then_ack(self):
  e=self.event();ledger=self.ledger(e);m.finish_pending(ledger)
  self.assertEqual(self.files[m.target_for(self.role)],e['content']);self.assertIsNone(ledger['pending'])
  self.assertEqual(ledger['roles'][self.role]['revision'],e['revision'])
 def test_partial_effect_recovery(self):
  e=self.event();ledger=self.ledger(e);self.files[m.target_for(self.role)]=e['content'];m.finish_pending(ledger)
  self.assertEqual(len(ledger['history']),1)
 def test_output_conflict_preserved(self):
  e=self.event();ledger=self.ledger(e);self.files[m.target_for(self.role)]='foreign bytes'
  with self.assertRaisesRegex(ValueError,'output_cas'):m.finish_pending(ledger)
  self.assertEqual(self.files[m.target_for(self.role)],'foreign bytes');self.assertFalse(ledger['roles'])
 def test_no_receipt_before_verified_effect(self):
  e=self.event();ledger=self.ledger(e)
  m.atomic=lambda path,body:None
  with self.assertRaisesRegex(ValueError,'output_verification'):m.finish_pending(ledger)
  self.assertFalse(ledger['roles']);self.assertIsNotNone(ledger['pending'])
 def test_dismiss_preserves_alias_ownership(self):
  e=self.event();e['content']=None;e['revision']=m.digest(m.encoded([self.role,e['sequence'],e['previous_revision'],None,e['enqueued_at']]))
  ledger=self.ledger(e);m.finish_pending(ledger)
  tomb=m.json.loads(self.files[m.target_for(self.role)]);self.assertEqual(tomb['operation'],'dismiss');self.assertEqual(tomb['notification_id'],m.target_for(self.role).stem)
 def test_origin_remains_first_beforeimage(self):
  first=self.event();ledger=self.ledger(first);m.finish_pending(ledger)
  second=self.event(first['content'].replace('technical detail','updated detail'));second['sequence']=2;second['previous_revision']=first['revision'];second['revision']=m.digest(m.encoded([self.role,2,second['previous_revision'],second['content'],second['enqueued_at']]))
  ledger['pending']={'role':self.role,'event':second,'before':first['content']};m.finish_pending(ledger)
  self.assertIsNone(ledger['origin'][self.role]);self.assertEqual(ledger['inverse'][self.role]['before'],first['content'])
 def test_origin_inverse_restores_initial_absence_and_reconciles_same_intent(self):
  from unittest.mock import patch
  e=self.event();ledger=self.ledger(e);m.finish_pending(ledger)
  self.files[m.STATE/'ledger.json']=m.encoded(ledger)
  with patch.object(m.os,'open',return_value=9),patch.object(m.os,'close'),patch.object(m.os,'fsync'),patch.object(m.fcntl,'flock'),patch.object(m.pathlib.Path,'unlink',lambda path,**kw:self.files.pop(path,None)):
   m.rollback(self.role,e['revision'],origin=True);m.rollback(self.role,e['revision'],origin=True)
  self.assertNotIn(m.target_for(self.role),self.files);saved=m.json.loads(self.files[m.STATE/'ledger.json']);self.assertTrue(saved['revoked']);self.assertTrue(saved['rollback_verified']['origin'])
 def test_delivery_scope_requires_test_label_and_owns_cleanup(self):
  self.role='delivery_test'
  with self.assertRaisesRegex(ValueError,'delivery_test_label'):m.validate_event(self.role,self.event())
  e=self.event(self.event()['content'].replace('incident','TESTE incident').replace('technical detail','TESTE technical detail'))
  m.validate_event(self.role,e);self.assertEqual(m.effective_content(self.role,e),e['content'])
  e['content']=None;self.assertIsNone(m.effective_content(self.role,e))
  self.assertIsNotNone(m.effective_content(m.ROLES[0],e))
if __name__=='__main__':unittest.main()

