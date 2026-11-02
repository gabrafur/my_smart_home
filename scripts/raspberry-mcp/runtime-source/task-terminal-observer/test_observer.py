"""Bounded fixture-only tests: never connect to the daemon or touch live ledgers."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('candidate_observer', Path(__file__).with_name('observer.py'))
o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
TASK='a'*32; OP='b'*32; THREAD='11111111-1111-1111-1111-111111111111'; TURN='22222222-2222-2222-2222-222222222222'
NOW=100000.0; SCOPE=95000

def terminal(op=OP, state='completed', updated=99900, turn=TURN, result=None):
    result = result if result is not None else {'operation_state':state,'turn_id':turn,'answer':'private'}
    return {'id':op,'task':TASK,'turn':turn,'state':state,'updated':updated,'result':json.dumps(result),'reconciled':0}

def pending():
    return {'id':OP,'task':TASK,'thread':THREAD,'turn':TURN,'state':'accepted','updated':99990}

class CandidateTests(unittest.TestCase):
    def test_fingerprint_matches_store_algorithm(self):
        value={'operation_state':'completed','answer':'ação'}
        self.assertEqual(o.fingerprint(value),hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest())

    def test_readonly_registry_retains_reconciled_24h_and_never_changes_db(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);p.chmod(0o700);db=p/'jobs.sqlite3';lock=p/'coordinator.lock';lock.touch(mode=0o600)
            c=sqlite3.connect(db);c.executescript('CREATE TABLE tasks(id TEXT PRIMARY KEY,thread TEXT); CREATE TABLE sends(id TEXT,task TEXT,state TEXT,turn TEXT,updated REAL,result TEXT,reconciled INTEGER);');c.execute('INSERT INTO tasks VALUES (?,?)',(TASK,THREAD))
            rows=[(OP,TASK,'accepted',TURN,99990,None,0),('c'*32,TASK,'accepted',TURN,99991,None,0),('d'*32,TASK,'completed',TURN,99900,json.dumps({'operation_state':'completed','turn_id':TURN}),1),('e'*32,TASK,'completed',TURN,90000,json.dumps({'operation_state':'completed','turn_id':TURN}),1),('f'*32,TASK,'failed',TURN,100,json.dumps({'operation_state':'failed','turn_id':TURN}),0)]
            c.executemany('INSERT INTO sends VALUES (?,?,?,?,?,?,?)',rows);c.commit();c.close();db.chmod(0o600);before=db.read_bytes()
            pending_rows, terminal_rows=o._rows(db,lock,os.geteuid(),SCOPE,lambda:NOW)
            self.assertEqual([x['id'] for x in pending_rows],[OP]);self.assertEqual({x['id'] for x in terminal_rows},{'d'*32,'f'*32});self.assertEqual(db.read_bytes(),before)
            Path(str(db)+'-wal').touch()
            with self.assertRaises(ValueError):o._rows(db,lock,os.geteuid(),SCOPE,lambda:NOW)

    def test_public_contract_and_private_result_redacted(self):
        result=o.collect(lambda:([],[terminal()]),lambda:True,now=lambda:NOW,scope_started_at=SCOPE)
        self.assertEqual(result['source'],'registered_task_terminal_observer_v1');self.assertEqual(result['state'],'observed');self.assertEqual(result['scope_started_at'],SCOPE);self.assertIsInstance(result['scope_started_at'],int);self.assertIn('registered_sends_only',result['coverage']);self.assertTrue(result['observed_at'].endswith('+00:00'))
        event=result['events'][0];self.assertEqual(event['operation_id'],OP);self.assertEqual(event['revision'],o.fingerprint(json.loads(terminal()['result'])));self.assertEqual(event['terminal_state'],'completed')
        text=json.dumps(result);self.assertNotIn('private',text);self.assertNotIn(TASK,text);self.assertNotIn(THREAD,text);self.assertNotIn(TURN,text)

    def test_invalid_cached_receipts_fail_closed(self):
        for row in (terminal(result={'operation_state':'failed','turn_id':TURN}),terminal(result={'operation_state':'completed','turn_id':THREAD}),terminal(updated=float('nan'))):
            with self.subTest(row=row):
                result=o.collect(lambda:([],[row]),lambda:True,now=lambda:NOW,scope_started_at=SCOPE);self.assertEqual(result['state'],'unknown');self.assertEqual(result['events'],[])

    def test_unavailable_adapter_never_emits_pending(self):
        result=o.collect(lambda:([pending()],[]),lambda:True,now=lambda:NOW,scope_started_at=SCOPE)
        self.assertEqual(result['collection_error'],'bounded_observe_adapter_unavailable');self.assertEqual(result['events'],[])

    def test_observe_only_race_fails_closed(self):
        class Probe:
            enforced_timeout_seconds=.2
            def __init__(self):self.requests=[]
            def __call__(self,q):self.requests.append(q);return {'turn_id':TURN,'operation_state':'completed','answer':'secret'}
        probe=Probe();it=iter([([pending()],[]),([],[])])
        result=o.collect(lambda:next(it),lambda:True,probe,now=lambda:NOW,scope_started_at=SCOPE)
        self.assertEqual(result['state'],'unknown');self.assertEqual([x['mode'] for x in probe.requests],['observe']);self.assertNotIn('secret',json.dumps(result))

    def test_fractional_scope_is_rejected_before_read(self):
        with self.assertRaises(ValueError):
            o.collect(lambda:self.fail('must not read'), lambda:True, now=lambda:NOW, scope_started_at=1.5)

    def test_policy_failure_does_not_read(self):
        result=o.collect(lambda:self.fail('must not read'),lambda:False,now=lambda:NOW,scope_started_at=SCOPE)
        self.assertEqual(result['state'],'unknown');self.assertEqual(result['events'],[])

    def test_65_terminals_fails_closed(self):
        rows=[terminal(format(i,'032x'),updated=99000+i) for i in range(65)]
        result=o.collect(lambda:([],rows),lambda:True,now=lambda:NOW,scope_started_at=SCOPE)
        self.assertEqual(result['state'],'unknown');self.assertEqual(result['collection_error'],'terminal_registry_truncated');self.assertEqual(result['events'],[])

if __name__=='__main__':unittest.main()
