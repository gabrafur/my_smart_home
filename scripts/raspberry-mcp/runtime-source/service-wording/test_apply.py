import contextlib,copy,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('wording',Path(__file__).with_name('apply.py'));a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
class Cases(unittest.TestCase):
 def setUp(self):
  self.template=a.raw({'fragments':{'service_unavailable':'old','check_service':'old','preserved':'same'},'fields':['unchanged']});self.before={'diagnostic_templates.json':self.template,'repair-policy.json':a.raw({'enabled':True,'expires_at':a.EXPIRY,'maximum_submissions':2,'dependencies':{a.TARGETS['diagnostic_templates.json']:'a'*64},'preserved':['unchanged']})};d=json.loads(self.template);d['fragments'].update(service_unavailable='Serviço indisponível; origem não comprovada',check_service='Confira o serviço registrado, o handler e suas dependências; a mensagem genérica não comprova serviço ausente nem identifica o provedor indisponível.');self.candidate=a.raw(d)
 def test_only_two_fragment_values_and_one_integrity_pin_change(self):
  r=a.proposed(self.before,self.candidate);before=json.loads(self.before['repair-policy.json']);after=json.loads(r['repair-policy.json']);before['dependencies'][a.TARGETS['diagnostic_templates.json']]=a.sha(self.candidate);self.assertEqual(before,after);self.assertEqual(r['diagnostic_templates.json'],self.candidate)
 def test_extra_content_codes_fields_or_language_refused(self):
  for edit in [lambda d:d['fragments'].update(extra='private'),lambda d:d.update(fields=[]),lambda d:d['fragments'].update(service_unavailable='Serviço do Home Assistant indisponível')]:
   d=json.loads(self.candidate);edit(d)
   with self.assertRaises(ValueError):a.proposed(self.before,a.raw(d))
 def test_scope_expiry_budget_and_disabled_authority_refused(self):
  for k,v in [('enabled',False),('expires_at',a.EXPIRY+1),('maximum_submissions',3)]:
   before=copy.deepcopy(self.before);d=json.loads(before['repair-policy.json']);d[k]=v;before['repair-policy.json']=a.raw(d)
   with self.assertRaises(ValueError):a.proposed(before,self.candidate)
 def test_manifest_change_does_not_read_candidates(self):
  with patch.object(a,'read',return_value=b'{}')as read:
   with self.assertRaisesRegex(ValueError,'manifest_changed'):a.load()
   self.assertEqual(read.call_count,1)
 def test_existing_intent_cannot_reapply(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);state=root/'state';state.mkdir();after=a.proposed(self.before,self.candidate)
   with patch.object(a,'STAGE',root),patch.object(a,'STATE',state),patch.object(a,'__file__',str(root/'apply.py')),patch.object(a.sys,'argv',['apply.py','apply-approved']),patch.object(a.os,'geteuid',return_value=0),patch.object(a.time,'time',return_value=a.EXPIRY-1000),patch.object(a,'load',return_value=({},after)),patch.object(a,'chains',return_value=object()),patch.object(a,'locks',return_value=contextlib.nullcontext()),patch.object(a,'baseline',return_value=self.before),patch.object(a,'atomic')as atomic:
    with self.assertRaisesRegex(ValueError,'existing_intent_requires_reconciliation'):a.main()
    atomic.assert_not_called()
if __name__=='__main__':unittest.main()
