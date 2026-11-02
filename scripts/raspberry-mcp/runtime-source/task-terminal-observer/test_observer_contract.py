"""Synthetic mocks only: no real socket, RPC, unit, or protected files."""
import hashlib
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).parent

def load(name):
    spec=importlib.util.spec_from_file_location('test_'+name,HERE/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

native=load('native_adapter'); boot=load('bootstrap')
OP='b'*32; THREAD='11111111-1111-1111-1111-111111111111'; TURN='22222222-2222-2222-2222-222222222222'

class AdapterTests(unittest.TestCase):
    def test_only_exact_registered_observe_may_execute_mock(self):
        row={'id':OP,'thread':THREAD,'turn':TURN};calls=[]
        def run(argv,**kwargs):
            calls.append((argv,kwargs));return types.SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'result':{'operation_state':'inProgress','turn_id':TURN}}).encode())
        a=native.Adapter(lambda:([row],[]),run=run);a.saved=(native.sha(b'old'),native.sha(b'new'),{})
        q={'mode':'observe','thread_id':THREAD,'turn_id':TURN,'operation_id':OP}
        with patch.object(native,'checked_bundle',return_value=(b'old',b'new',{})),patch.object(a,'check_peer',return_value=None):
            self.assertEqual(a(q)['operation_state'],'inProgress')
            for altered in ({**q,'mode':'send'},{**q,'operation_id':'c'*32},{**q,'thread_id':TURN}):
                with self.assertRaises(ValueError):a(altered)
        self.assertEqual(len(calls),1);self.assertEqual(calls[0][1]['timeout'],1.2);self.assertEqual(json.loads(calls[0][1]['input']),q)

    def test_changed_policy_blocks_before_mock_process(self):
        a=native.Adapter(lambda:([{'id':OP,'thread':THREAD,'turn':TURN}],[]),run=lambda *a,**k:self.fail('must not run'));a.saved=('x','y',{})
        with patch.object(native,'checked_bundle',return_value=(b'old',b'new',{})):
            with self.assertRaises(ValueError):a({'mode':'observe','thread_id':THREAD,'turn_id':TURN,'operation_id':OP})

class BootstrapTests(unittest.TestCase):
    def test_verified_mock_sources_call_only_observation_and_publish(self):
        source={n:(n+' fixture').encode() for n in boot.NAMES};scope=100
        cfg={'schema_version':1,'enabled':True,'scope_started_at':scope,'source_hashes':{n:hashlib.sha256(v).hexdigest() for n,v in source.items()}};raw=json.dumps(cfg).encode();events=[]
        report={'state':'observed'}
        observer=types.SimpleNamespace(production_rows=lambda scope:([],[]),collect=lambda rows,check,adapter,**kwargs:(events.append(('collect',kwargs['scope_started_at'])),report)[1],publish_snapshot=lambda r:events.append(('publish',r)))
        adapter=types.SimpleNamespace(Adapter=lambda rows:object())
        def read(path):return raw if path==boot.CONFIG else source[Path(path).name]
        def module(name,raw,path):return observer if name=='task_terminal_observer' else adapter
        with patch.object(boot.os,'geteuid',return_value=1001),patch.object(boot,'root_read',side_effect=read),patch.object(boot,'module',side_effect=module),patch.object(boot.time,'time',return_value=200):
            self.assertEqual(boot.run(hashlib.sha256(raw).hexdigest()),'observed')
        self.assertEqual(events,[('collect',scope),('publish',report)])

    def test_bad_config_never_loads_code(self):
        with patch.object(boot.os,'geteuid',return_value=1001),patch.object(boot,'root_read',return_value=b'{}'),patch.object(boot,'module',side_effect=AssertionError('must not load')):
            with self.assertRaises(ValueError):boot.run('0'*64)

if __name__=='__main__':unittest.main()
