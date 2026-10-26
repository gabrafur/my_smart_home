import importlib.util,json,tempfile,types,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('static_identity',Path(__file__).with_name('static_code_identity.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
# This is installed, pinned, pure fingerprint logic, not a proposed-code import.
spec=importlib.util.spec_from_file_location('trusted_native_fingerprint',(Path(__file__).resolve().parent.parent/'runtime-source/host-heartbeat/loaded_identity.py'));native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
class StaticIdentity(unittest.TestCase):
 def sources(self):return {label:b'def sample(x):\n return x+1\n'for label in m.MODULES}
 def test_same_domain_as_actual_function_objects(self):
  sources=self.sources();sources['history']=b'class History:\n @staticmethod\n def static(x):return x+2\n @classmethod\n def make(cls,x):return x+3\n def nested(self):\n  def inner(x):return x\n  return inner(1)\n';functions={}
  for label,raw in sources.items():
   module=types.ModuleType('synthetic_'+label);exec(compile(raw,'<synthetic-fixture>','exec'),module.__dict__);functions.update(native._functions(label,module))
  result=m.SourceCodeIdentity(native.fingerprint).compile(sources);self.assertEqual(result['expected_code_sha256'],native.fingerprint(functions));self.assertFalse(result['proposal_code_executed'])
 def test_top_level_proposed_effect_never_runs(self):
  with tempfile.TemporaryDirectory()as tmp:
   target=Path(tmp)/'must-not-exist';sources=self.sources();sources['heartbeat']=("open("+repr(str(target))+",'w').write('untrusted')\ndef sample(x):return x\n").encode();result=m.SourceCodeIdentity(native.fingerprint).compile(sources);self.assertFalse(target.exists());self.assertIn('not_security_review_sandbox_or_approval',result['coverage'])
 def test_dynamic_or_duplicate_inventory_rejected(self):
  for raw in [b'@unknown\ndef f():pass',b'def f():pass\ndef f():pass',b'if True:\n def f():pass',b'@unknown\nclass C:pass',b'class C:\n class Inner:pass',b'class C:\n def f(self):pass\n def f(self):pass']:
   sources=self.sources();sources['heartbeat']=raw
   with self.assertRaises(ValueError):m.SourceCodeIdentity(native.fingerprint).compile(sources)
 def test_fixed_scope_and_resource_limit(self):
  for sources in [{},dict(self.sources(),arbitrary=b'def f():pass'),{**self.sources(),'heartbeat':b'x'*65537}]:
   with self.assertRaises(ValueError):m.SourceCodeIdentity(native.fingerprint).compile(sources)
 def test_source_set_and_code_changes_are_separate(self):
  first=self.sources();second={**first,'heartbeat':b'# comment\ndef sample(x):\n return x+1\n'};a=m.SourceCodeIdentity(native.fingerprint).compile(first);b=m.SourceCodeIdentity(native.fingerprint).compile(second);self.assertEqual(a['expected_code_sha256'],b['expected_code_sha256']);self.assertNotEqual(a['source_set_sha256'],b['source_set_sha256'])
if __name__=='__main__':unittest.main()
