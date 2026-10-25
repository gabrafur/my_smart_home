import copy,importlib.util,json,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('notice_content_test_reader',Path(__file__).with_name('notification_reader.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
NOW=1792926000
STAMP='2026-10-25T11:00:00Z'
def error():return {'exception_type':'TypeError','message_codes':['switch_operator'],'reason_codes':['switch_operator'],'stack':[{'source':'node-red/core/function/10-switch.js','line':123,'function':'SwitchNode'}],'redacted_fields':[],'collection_error':None}
def diagnostic():return {'schema_version':1,'title_codes':['flow_failure'],'message_codes':['flow_host','node_age','execution_error'],'integration_codes':['node_red'],'reason_codes':['switch_operator'],'guidance_code':'check_switch','redacted_fields':[{'field':'message','reason':'credential'}],'error':error(),'raw_content_persisted':False,'untrusted_source_text':True,'rendering':'reviewed_diagnostic_fragments_only'}
def notice(i=1):return {'id':f'{i:064x}','revision':'b'*64,'observed_at':STAMP,'created_or_updated_at':STAMP,'category':'unclassified','summary':'Notificação persistente; conteúdo não exportado','category_basis':'unknown','content_withheld':True,'diagnostics':diagnostic()}
def snapshot():return {'schema_version':1,'observed_at':STAMP,'collection_error':None,'connection_state':'subscribed','last_transport_confirmation_at':STAMP,'notifications':[notice(i)for i in range(1,21)],'events':[]}
class ContentTests(unittest.TestCase):
 def call(self,data=None,association=None,now=NOW+1,**args):
  data=data or snapshot()
  def read(path):
   if path==r.ASSOCIATED:
    if association is None:raise FileNotFoundError()
    return json.dumps(association).encode()
   return json.dumps(data).encode()
  with patch.object(r,'read',side_effect=read):return r.evidence({'host':'raspberry',**args},clock=lambda:now)
 def test_title_message_type_reason_guidance_and_redaction_available(self):
  d=self.call();self.assertEqual(d['state'],'observed');n=d['notifications'][0];self.assertIn('Node-RED',n['title']);self.assertIn('Idade',n['message']);self.assertEqual(n['error_type'],'TypeError');self.assertEqual(n['associated_errors'][0]['stack'][0]['line'],123);self.assertTrue(n['redacted_fields']);self.assertFalse(n['recovery_proven'])
 def test_ID_filter_pages_and_stable_digest_independent_of_age(self):
  first=self.call();page=self.call(offset=16,expected_digest=first['digest']);self.assertEqual(len(page['notifications']),4);same=self.call(now=NOW+2,expected_digest=first['digest']);self.assertEqual(same['digest'],first['digest']);one=self.call(notification_id=notice(3)['id']);self.assertEqual(len(one['notifications']),1);self.assertEqual(one['notifications'][0]['id'],notice(3)['id'])
 def test_content_change_invalidates_pagination(self):
  first=self.call();data=snapshot();data['notifications'][0]['diagnostics']['message_codes']=['authentication'];d=self.call(data,offset=16,expected_digest=first['digest']);self.assertEqual(d['collection_error'],'snapshot_changed');self.assertEqual(d['notifications'],[])
 def test_current_removed_unavailable_not_recovery(self):
  data=snapshot();data['events']=[{'object_id':'f'*64,'phase':'removed','observed_at':STAMP,'sequence':1}];removed=self.call(data,notification_id='f'*64)['notifications'][0];self.assertEqual(removed['notification_state'],'removed');self.assertIsNone(removed['message']);self.assertFalse(removed['recovery_proven']);unknown=self.call(notification_id='a'*64)['notifications'][0];self.assertEqual(unknown['notification_state'],'unavailable')
 def test_failed_or_stale_collection_does_not_claim_current(self):
  for change in [{'collection_error':'connection_failed'},{'observed_at':'2026-10-25T10:00:00Z'}]:
   data=snapshot();data.update(change);d=self.call(data);self.assertEqual(d['notifications'][0]['notification_state'],'unavailable');self.assertFalse(d['notifications'][0]['recovery_proven'])
 def test_correlated_stack_requires_exact_ID_no_private_fields(self):
  a={'schema_version':1,'source':'nodered.sanitized_notification_diagnostics','records':[{'notification_id':notice(3)['id'],'observed_at':STAMP,'error':error(),'private':'PRIVATE_SENTINEL'}]};d=self.call(association=a);n=d['notifications'][2];self.assertEqual(n['associated_errors'][0]['association'],'exact_canonical_notification_id_latest_diagnostic');self.assertFalse(n['associated_errors'][0]['association_is_root_cause_proof']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d));self.assertEqual(d['notifications'][1]['associated_errors'][0]['association'],'embedded_in_notification')
 def test_tampered_codes_free_text_stack_path_and_error_name_fail_closed(self):
  for change in [{'title_codes':['PRIVATE_SENTINEL']},{'error':{**error(),'exception_type':'PRIVATE_SENTINEL'}},{'error':{**error(),'stack':[{'source':'/private/PRIVATE_SENTINEL','line':2,'function':None}]}}]:
   value=diagnostic();value.update(change);out=r.content.project(value);self.assertFalse(out['sanitized_content_available']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(out))
 def test_response_page_respects_real_broker_byte_limit(self):
  data=snapshot()
  for row in data['notifications']:
   row['diagnostics']['message_codes']=['check_service']*16
   row['diagnostics']['title_codes']=['check_service']*16
  got=self.call(data);self.assertIsNone(got['collection_error']);self.assertLess(len(json.dumps(got).encode()),60000);self.assertLess(got['next_offset'],16);nxt=self.call(data,offset=got['next_offset'],expected_digest=got['digest']);self.assertIsNone(nxt['collection_error']);self.assertNotEqual(got['notifications'][0]['id'],nxt['notifications'][0]['id'])
 def test_parameters_cannot_select_host_path_or_raw_ID(self):
  for args in [{'host':'other'},{'path':'/etc/passwd'},{'notification_id':'private@example.invalid'},{'notification_id':'a'*64,'offset':1}]:
   with self.assertRaises(ValueError):r.evidence({'host':'raspberry',**args})
if __name__=='__main__':unittest.main()
