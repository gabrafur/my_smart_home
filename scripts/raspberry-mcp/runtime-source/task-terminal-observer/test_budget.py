import hashlib, importlib.util, json, types, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('budget_bootstrap',Path(__file__).with_name('bootstrap.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class BudgetTests(unittest.TestCase):
 def fixture(self, fail_phase=None):
  sources={name:(name+' fixture').encode() for name in b.NAMES}
  cfg={'schema_version':1,'enabled':True,'scope_started_at':100,'source_hashes':{k:hashlib.sha256(v).hexdigest() for k,v in sources.items()}}
  raw=json.dumps(cfg).encode();events=[];armed=[False];diagnostics=[]
  def timer(kind,value):armed[0]=value>0;events.append(('timer',value))
  def read(path):
   self.assertTrue(armed[0]);events.append(('read',str(path)))
   if fail_phase=='read':raise b.ObservationDeadline()
   return raw if path==b.CONFIG else sources[Path(path).name]
  def publish(report):
   self.assertTrue(armed[0]);events.append(('publish',report))
   if fail_phase=='publish':raise b.ObservationDeadline()
  def collect(*args,**kwargs):
   self.assertTrue(armed[0]);events.append(('collect',))
   if fail_phase=='collect':raise b.ObservationDeadline()
   return {'state':'observed'}
  observer=types.SimpleNamespace(production_rows=lambda s:([],[]),collect=collect,publish_snapshot=publish)
  adapter=types.SimpleNamespace(Adapter=lambda rows:object())
  with patch.object(b.os,'geteuid',return_value=1001),patch.object(b,'root_read',side_effect=read),patch.object(b,'module',side_effect=lambda name,*args:observer if name=='task_terminal_observer' else adapter),patch.object(b.time,'time',return_value=200),patch.object(b.signal,'signal',return_value=None),patch.object(b.signal,'setitimer',side_effect=timer),patch.object(b.os,'write',side_effect=lambda fd,data:diagnostics.append(json.loads(data))):
   if fail_phase:
    with self.assertRaisesRegex(TimeoutError,'observer_deadline'):b.run(hashlib.sha256(raw).hexdigest())
   else:self.assertEqual(b.run(hashlib.sha256(raw).hexdigest()),'observed')
  self.assertFalse(armed[0]);self.assertEqual(events[0],('timer',1.85));self.assertEqual(events[-1],('timer',0))
  return events,diagnostics
 def test_entire_run_has_budget(self):self.fixture()
 def test_setup_deadline_does_not_publish(self):
  e,d=self.fixture('read');self.assertFalse(any(x[0]=='publish' for x in e));self.assertEqual(d[0]['phase'],'sealed_sources')
 def test_collection_cannot_swallow_deadline(self):
  e,d=self.fixture('collect');self.assertFalse(any(x[0]=='publish' for x in e));self.assertEqual(d[0]['phase'],'collect')
 def test_publication_deadline_is_not_success(self):
  e,d=self.fixture('publish');self.assertEqual(d[0]['phase'],'publish');self.assertEqual(set(d[0]),{'schema_version','source','phase','failure_class','elapsed_ms'})
if __name__=='__main__':unittest.main()
