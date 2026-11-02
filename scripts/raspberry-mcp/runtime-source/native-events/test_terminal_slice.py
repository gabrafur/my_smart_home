"""Synthetic protocol slice; no network, installed state or residential effects."""
import hashlib
import importlib.util
from pathlib import Path
import json
import tempfile
import unittest
import registry
import worker
from unittest.mock import patch
import delivery_summary as summary
COVERAGE=['registered_sends_only','one_pending_RPC_per_sample','no_dispatch','no_task_ledger_mutation','reconciled_terminals_retained_24h_after_observer_scope_start','no_delivery_or_functional_recovery_proof']


class TerminalSlice(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.now = 1800000000.0
        self.reg = registry.Registry(self.tmp.name, 'fixture_principal', approved=True,
                                     sender=lambda *args: (_ for _ in ()).throw(TimeoutError()),
                                     clock=lambda: self.now)
        self.addCleanup(self.reg.db.close)
    def args(self, topics): return {'project': registry.PROJECT, 'topics': topics}
    def add(self, topic, source, phase, n=0):
        op='a'*32; obj=hashlib.sha256(('task-terminal-operation-v1:'+op).encode()).hexdigest() if topic=='task_terminal' else 'a'*64
        return self.reg.enqueue(topic, source, phase, obj, hashlib.sha256(str(n).encode()).hexdigest(), self.now, *([op,'completed'] if topic=='task_terminal' else []))
    def test_legacy_filter_identity_is_exact_and_new_topic_is_opt_in(self):
        self.assertEqual(registry.filters(self.args(['ha_notification'])), self.args(['ha_notification']))
        self.assertEqual(registry.filters(self.args(['task_terminal','ha_notification'])), self.args(['ha_notification','task_terminal']))
        delivery = {'mode':'webhook','url':'https://callback.example.org/events'}
        old, _ = self.reg.identity(registry.NAME, self.args(['ha_notification']), delivery)
        expected = hashlib.sha256(registry.canonical(['fixture_principal', registry.NAME, self.args(['ha_notification']), delivery['url']]).encode()).hexdigest()
        self.assertEqual(old, expected)
        changed, _ = self.reg.identity(registry.NAME, self.args(['ha_notification','task_terminal']), delivery)
        self.assertNotEqual(old, changed)
        for bad in ([], ['task_terminal','task_terminal'], ['task_terminal','foreign'], ['ha_notification']*3):
            with self.subTest(bad=bad), self.assertRaises(ValueError): registry.filters(self.args(bad))
    def test_explicit_migration_preserves_legacy_identity_and_lifetime(self):
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        delivery={'mode':'webhook','url':'https://callback.example.org/events','secret':secret}
        old,_=self.reg.identity(registry.NAME,self.args(['ha_notification']),delivery)
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (old,'fixture_principal',registry.canonical(self.args(['ha_notification'])),delivery['url'],secret,None,0,self.now+2000,self.now,self.now-50,1))
        params={'name':registry.NAME,'arguments':self.args(['ha_notification','task_terminal']),'delivery':delivery}
        with patch.object(registry,'verify_callback') as verify:
            result=self.reg._subscribe(params);verify.assert_called_once()
        rows=self.reg.db.execute('SELECT id,args,active,started,expires FROM subscriptions ORDER BY active').fetchall()
        self.assertEqual(len(rows),2);self.assertEqual(rows[0]['id'],old);self.assertEqual(rows[0]['active'],0)
        self.assertEqual(rows[1]['id'],result['id']);self.assertEqual(rows[1]['started'],self.now-50)
        self.assertEqual(rows[1]['expires'],self.now+2000)
        self.assertEqual(tuple(self.reg.db.execute('SELECT successor,predecessor FROM subscription_lineage').fetchone()),(result['id'],old))

    def test_migration_preserves_pending_and_excludes_uncertain_prior_members(self):
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        delivery={'mode':'webhook','url':'https://callback.example.org/events','secret':secret}
        old,_=self.reg.identity(registry.NAME,self.args(['ha_notification']),delivery)
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (old,'fixture_principal',registry.canonical(self.args(['ha_notification'])),delivery['url'],secret,None,0,self.now+2000,self.now,self.now-50,1))
        covered=self.add('ha_notification','ha_persistent_notification','added',1)['id']
        self.reg.db.execute('INSERT INTO delivery_members VALUES(?,?,?)',(old,covered,'b'*64))
        self.reg.db.execute("INSERT INTO dispatch VALUES(?,?,'uncertain',?)",(old,'b'*64,self.now-601))
        pending=self.add('ha_notification','ha_persistent_notification','added',2)['id']
        params={'name':registry.NAME,'arguments':self.args(['ha_notification','task_terminal']),'delivery':delivery}
        with patch.object(registry,'verify_callback'): result=self.reg._subscribe(params)
        sub,rows,_=self.reg.summary_plan(self.now)
        self.assertEqual(sub['id'],result['id']);self.assertEqual([row['id'] for row in rows],[pending])
        self.assertEqual(self.reg.event_counts(self.now)['eligible_pending_event_records'],1)
        self.assertEqual(self.reg.db.execute('SELECT state FROM dispatch').fetchone()[0],'uncertain')
        with patch.object(registry,'verify_callback') as verify:
            again=self.reg._subscribe(params);verify.assert_not_called()
        self.assertEqual(again['id'],result['id']);self.assertEqual(self.reg.db.execute('SELECT count(*) FROM subscription_lineage').fetchone()[0],1)

    def test_migration_callback_failure_and_foreign_scope_are_atomic(self):
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        delivery={'mode':'webhook','url':'https://callback.example.org/events','secret':secret}
        old,_=self.reg.identity(registry.NAME,self.args(['ha_notification']),delivery)
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (old,'fixture_principal',registry.canonical(self.args(['ha_notification'])),delivery['url'],secret,None,0,self.now+2000,self.now,self.now-50,1))
        params={'name':registry.NAME,'arguments':self.args(['ha_notification','task_terminal']),'delivery':delivery}
        with patch.object(registry,'verify_callback',side_effect=ValueError('fixture')):
            with self.assertRaises(ValueError): self.reg._subscribe(params)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM subscription_lineage').fetchone()[0],0)
        self.assertEqual(self.reg.db.execute('SELECT active FROM subscriptions WHERE id=?',(old,)).fetchone()[0],1)
        params['delivery']={**delivery,'url':'https://other.example.org/events'}
        with self.assertRaisesRegex(ValueError,'subscription_limit'):self.reg._subscribe(params)

    def test_client_policy_is_separate_fail_closed_and_expiring(self):
        fixed={**worker.CLIENT_POLICY_EXPECTED,'expires_at':1800000100,'approval_sha256':'a'*64}
        def observe(value,now=1800000000):return worker.read_client_policy(lambda:now,lambda:json.dumps(value).encode())
        self.assertEqual(observe(fixed,1790000000)['state'],'approved')
        self.assertFalse(observe(fixed,1800000200)['approval_active'])
        for altered in ({**fixed,'approval_sha256':'PENDING'}, {**fixed,'client_neutral':1},
                        {**fixed,'allowed_tools':['foreign']},{**fixed,'extra':1}):
            self.assertEqual(observe(altered,1790000000)['state'],'unknown')
        for expiry in (True,'1800000100',None,-1,253402300800):
            with self.subTest(expiry=expiry):self.assertEqual(observe({**fixed,'expires_at':expiry},1790000000)['state'],'unknown')
        self.assertEqual(worker.read_client_policy(lambda:1790000000,lambda:(_ for _ in ()).throw(OSError()))['state'],'unknown')

    def test_scope_health_and_client_policy_separate_continuation_from_admission(self):
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('fixture','fixture_principal',registry.canonical(self.args(['ha_notification','task_terminal'])),
             'https://callback.example.org/events',secret,None,0,self.now+86400,self.now,self.now-60,1))
        engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        base={'schema_version':1,'source':'registered_task_terminal_observer_v1','observed_at':summary.iso(self.now),
              'state':'observed','collection_error':None,'scope_started_at':int(self.now)-10,'coverage':COVERAGE,'events':[]}
        with patch.object(worker,'safe_json',return_value=base):self.assertTrue(engine.ingest_terminal())
        policy={'state':'approved','approval_active':True,'execution_proven':False}
        with patch.object(worker,'read_client_policy',return_value=policy):status=engine.request({'method':'status','params':{}},1001)
        scope=status['subscription_scope'];self.assertEqual(scope['topics'],['ha_notification','task_terminal'])
        self.assertEqual(scope['subscription_id_sha256'],hashlib.sha256(b'fixture').hexdigest())
        self.assertNotIn('https://callback.example.org',json.dumps(scope));self.assertTrue(status['client_execution_policy']['continuation_ready'])
        self.assertFalse(status['client_execution_policy']['execution_proven']);self.assertEqual(status['terminal_source_health']['age_seconds'],0)
        extra={'subscription_scope':scope,'terminal_source_health':status['terminal_source_health'],'continuation_ready':status['client_execution_policy']['continuation_ready']}
        self.assertLessEqual(len(json.dumps(extra,separators=(',',':')).encode()),1024)
        self.now+=121
        with patch.object(worker,'read_client_policy',return_value={'state':'approved','approval_active':True,'execution_proven':False}):
            stale=engine.request({'method':'status','params':{}},1001)
        self.assertFalse(stale['client_execution_policy']['continuation_ready']);self.assertEqual(stale['terminal_source_health']['collection_error'],'terminal_snapshot_stale')
        with patch.object(worker,'safe_json',return_value={**base,'state':'unknown','collection_error':'task_coordinator_busy'}):self.assertFalse(engine.ingest_terminal())
        self.assertEqual(engine.terminal_source_health['source_collection_error'],'task_coordinator_busy')
        self.assertIn('not_household_outage',' '.join(engine.terminal_source_health['coverage']))

    def test_unsubscribe_then_restart_and_optin_preserves_pending_and_uncertain(self):
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        delivery={'mode':'webhook','url':'https://callback.example.org/events','secret':secret}
        old,_=self.reg.identity(registry.NAME,self.args(['ha_notification']),delivery)
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (old,'fixture_principal',registry.canonical(self.args(['ha_notification'])),delivery['url'],secret,None,0,self.now+2000,self.now,self.now-50,1))
        covered=self.add('ha_notification','ha_persistent_notification','added',1)['id'];pending=self.add('ha_notification','ha_persistent_notification','added',2)['id']
        self.reg.db.execute('INSERT INTO delivery_members VALUES(?,?,?)',(old,covered,'b'*64))
        self.reg.db.execute("INSERT INTO dispatch VALUES(?,?,'uncertain',?)",(old,'b'*64,self.now-601))
        oldrequest={'name':registry.NAME,'arguments':self.args(['ha_notification']),'delivery':{'url':delivery['url']}}
        self.assertEqual(self.reg.unsubscribe(oldrequest),{})
        self.assertEqual(self.reg.db.execute('SELECT secret FROM subscriptions WHERE id=?',(old,)).fetchone()[0],'')
        self.reg.db.close();self.reg=registry.Registry(self.tmp.name,'fixture_principal',approved=True,sender=lambda *a:(_ for _ in ()).throw(TimeoutError()),clock=lambda:self.now)
        self.addCleanup(self.reg.db.close)
        params={'name':registry.NAME,'arguments':self.args(['ha_notification','task_terminal']),'delivery':delivery}
        with patch.object(registry,'verify_callback') as verify: result=self.reg._subscribe(params);verify.assert_called_once()
        new=self.reg.db.execute('SELECT started,expires FROM subscriptions WHERE id=?',(result['id'],)).fetchone()
        self.assertEqual((new['started'],new['expires']),(self.now-50,self.now+2000))
        self.assertEqual(self.reg.db.execute('SELECT predecessor FROM subscription_lineage').fetchone()[0],old)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM subscription_transition_markers').fetchone()[0],0)
        self.assertEqual([row['id'] for row in self.reg.summary_plan(self.now)[1]],[pending])
        self.assertEqual(self.reg.dispatch_one()['state'],'uncertain')
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0],2)
        self.reg.unsubscribe(oldrequest)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM subscription_transition_markers').fetchone()[0],0)
        self.assertEqual(self.reg.db.execute('SELECT active FROM subscriptions WHERE id=?',(result['id'],)).fetchone()[0],1)

    def test_unsubscribe_first_failed_callback_and_outside_window(self):
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        delivery={'mode':'webhook','url':'https://callback.example.org/events','secret':secret}
        old,_=self.reg.identity(registry.NAME,self.args(['ha_notification']),delivery)
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (old,'fixture_principal',registry.canonical(self.args(['ha_notification'])),delivery['url'],secret,None,0,self.now+2000,self.now,self.now-50,1))
        request={'name':registry.NAME,'arguments':self.args(['ha_notification']),'delivery':{'url':delivery['url']}}
        self.reg.unsubscribe(request)
        params={'name':registry.NAME,'arguments':self.args(['ha_notification','task_terminal']),'delivery':delivery}
        with patch.object(registry,'verify_callback',side_effect=ValueError('callback_failed')):
            with self.assertRaises(ValueError):self.reg._subscribe(params)
        self.assertEqual(self.reg.db.execute('SELECT active FROM subscriptions WHERE id=?',(old,)).fetchone()[0],0)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM subscription_lineage').fetchone()[0],0)
        self.now+=301
        with patch.object(registry,'verify_callback') as verify:
            with self.assertRaisesRegex(ValueError,'subscription_transition_unconfirmed'):self.reg._subscribe(params)
            verify.assert_not_called()
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM subscription_lineage').fetchone()[0],0)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM subscriptions').fetchone()[0],1)

    def test_only_exact_topic_source_phase_pairs_enter_store(self):
        self.assertFalse(self.add('task_terminal','registered_task_status','terminal')['duplicate'])
        self.assertTrue(self.add('task_terminal','registered_task_status','terminal')['duplicate'])
        for topic,source,phase in [('task_terminal','ha_persistent_notification','terminal'),
                                   ('ha_notification','registered_task_status','added'),
                                   ('task_terminal','registered_task_status','added'),
                                   ('ha_notification','ha_persistent_notification','terminal')]:
            with self.subTest(topic=topic,phase=phase), self.assertRaises(ValueError): self.add(topic,source,phase)
    def test_batches_are_separate_typed_and_do_not_claim_recovery(self):
        self.add('ha_notification','ha_persistent_notification','added',1)
        self.add('task_terminal','registered_task_status','terminal',2)
        rows=self.reg.db.execute('SELECT * FROM events ORDER BY topic').fetchall()
        ha=[r for r in rows if r['topic']=='ha_notification']; terminal=[r for r in rows if r['topic']=='task_terminal']
        with self.assertRaises(ValueError): summary.group_events(rows,self.now)
        with self.assertRaises(ValueError): summary.group_terminal_events(rows,self.now)
        old=summary.make_batch(summary.group_events(ha,self.now),'fixture',self.now,None)
        new=summary.make_terminal_batch(summary.group_terminal_events(terminal,self.now),'fixture',self.now)
        a,b=json.loads(old[1])['data'],json.loads(new[1])['data']
        self.assertEqual((a['topic'],a['delivery_kind']),('ha_notification','notification_summary_v1'))
        self.assertEqual((b['topic'],b['source'],b['delivery_kind']),('task_terminal','registered_task_status','task_terminal_summary_v1'))
        self.assertFalse(b['functional_recovery_proven']);self.assertEqual(b['assistant_execution'],'unknown')
        self.assertEqual(len(new[2]),1)
    def test_mixed_delivery_oldest_topic_separate_receipt_and_no_retry(self):
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('fixture','fixture_principal',registry.canonical(self.args(['ha_notification','task_terminal'])),
             'https://callback.example.org/events',secret,None,0,self.now+86400,self.now,self.now-10,1))
        self.add('task_terminal','registered_task_status','terminal',1)
        self.now += 1; self.add('ha_notification','ha_persistent_notification','added',2)
        first=self.reg.dispatch_one();self.assertEqual(first['delivery_kind'],summary.TERMINAL_VERSION)
        self.assertEqual(first['state'],'uncertain')
        receipt=self.reg.latest_delivery_receipt(self.now)
        self.assertEqual(receipt['state'],'observed');self.assertEqual(receipt['delivery_kind'],summary.TERMINAL_VERSION)
        self.assertEqual(receipt['members'][0]['phase'],'terminal');self.assertFalse(receipt['functional_recovery_proven'])
        self.assertEqual(self.reg.dispatch_one()['state'],'budget_held')
        self.now += 601;second=self.reg.dispatch_one()
        self.assertEqual(second['delivery_kind'],summary.VERSION);self.assertEqual(second['state'],'uncertain')
        self.now += 601;self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0],2)

    def test_terminal_snapshot_validated_before_ingest_without_raw_identifiers(self):
        op='a'*32; opaque=hashlib.sha256(('task-terminal-operation-v1:'+op).encode()).hexdigest()
        event={'topic':'task_terminal','source':'registered_task_status','phase':'terminal',
               'object_id':opaque,'revision':'b'*64,'observed_at':int(self.now),
               'operation_id':op,'terminal_state':'completed','result_updated_at':int(self.now)}
        snapshot={'schema_version':1,'source':'registered_task_terminal_observer_v1','observed_at':summary.iso(self.now),
                  'state':'observed','collection_error':None,'scope_started_at':int(self.now)-10,'coverage':COVERAGE,'events':[event]}
        engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        with patch.object(worker,'safe_json',return_value=snapshot) as read:
            self.assertTrue(engine.ingest_terminal());self.assertTrue(engine.ingest_terminal())
            read.assert_called_with(worker.TERMINAL_SNAPSHOT,65536,1001,0o640,True)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],1)
        snapshot['events'].append({**event,'object_id':'0'*64})
        with patch.object(worker,'safe_json',return_value=snapshot):self.assertFalse(engine.ingest_terminal())
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],1)

    def test_observer_snapshot_to_terminal_receipt_end_to_end(self):
        spec=importlib.util.spec_from_file_location('fixture_observer',Path(__file__).resolve().parent.parent/'task-terminal-observer'/'observer.py')
        observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
        op='c'*32; report={'state':'observed','collection_error':None,'observed_at':self.now,
          'terminal_unreconciled':[{'operation_id':op,'state':'completed','result_hash':'b'*64,'updated_at':self.now-2.5}],
          'pending':None}
        snapshot=observer.public_snapshot(report,int(self.now)-60)
        engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        with patch.object(worker,'safe_json',return_value=snapshot):self.assertTrue(engine.ingest_terminal())
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('fixture','fixture_principal',registry.canonical(self.args(['task_terminal'])),
             'https://callback.example.org/events',secret,None,0,self.now+86400,self.now,self.now-10,1))
        result=self.reg.dispatch_one();self.assertEqual(result['state'],'uncertain')
        receipt=self.reg.latest_delivery_receipt(self.now)
        self.assertEqual(receipt['state'],'observed');self.assertEqual(receipt['members'][0]['operation_id'],op)
        self.assertEqual(receipt['members'][0]['terminal_state'],'completed')
        self.assertFalse(receipt['functional_recovery_proven']);self.assertEqual(receipt['assistant_execution'],'unknown')

    def test_fresh_terminal_then_cached_reconciled_is_one_event_and_delivery(self):
        spec=importlib.util.spec_from_file_location('fixture_observer',Path(__file__).resolve().parent.parent/'task-terminal-observer'/'observer.py')
        observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
        op='c'*32;task='d'*32;thread='11111111-1111-1111-1111-111111111111';turn='22222222-2222-2222-2222-222222222222'
        pending={'id':op,'task':task,'thread':thread,'turn':turn,'state':'accepted','updated':self.now-20}
        response={'turn_id':turn,'operation_state':'completed','completed_at':self.now-2.5}
        class Probe:
            enforced_timeout_seconds=.1
            def __call__(self,request):return response
        fresh=observer.collect(lambda:([pending],[]),lambda:True,Probe(),now=lambda:self.now,scope_started_at=int(self.now)-60)
        self.assertEqual(fresh['state'],'observed');engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        with patch.object(worker,'safe_json',return_value=fresh):self.assertTrue(engine.ingest_terminal())
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('fixture','fixture_principal',registry.canonical(self.args(['task_terminal'])),
             'https://callback.example.org/events',secret,None,0,self.now+86400,self.now,self.now-60,1))
        self.assertEqual(self.reg.dispatch_one()['state'],'uncertain')
        self.now+=1
        cached={'id':op,'task':task,'turn':turn,'state':'completed','updated':self.now,'result':json.dumps(response),'reconciled':1}
        later=observer.collect(lambda:([],[cached]),lambda:True,now=lambda:self.now,scope_started_at=int(self.now)-60)
        self.assertEqual(later['state'],'observed');self.assertEqual(later['events'][0]['revision'],fresh['events'][0]['revision'])
        self.assertEqual(later['events'][0]['result_updated_at'],fresh['events'][0]['result_updated_at'])
        with patch.object(worker,'safe_json',return_value=later):self.assertTrue(engine.ingest_terminal())
        self.now+=601;self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],1)
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0],1)

    def test_not_dispatched_event_delivers_receipt_without_execution_claim(self):
        op='e'*32;opaque=hashlib.sha256(('task-terminal-operation-v1:'+op).encode()).hexdigest()
        event={'topic':'task_terminal','source':'registered_task_status','phase':'terminal','object_id':opaque,
               'revision':'b'*64,'observed_at':int(self.now),'operation_id':op,'terminal_state':'not_dispatched','result_updated_at':None}
        snapshot={'schema_version':1,'source':'registered_task_terminal_observer_v1','observed_at':summary.iso(self.now),
                  'state':'observed','collection_error':None,'scope_started_at':int(self.now)-10,'coverage':COVERAGE,'events':[event]}
        engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        with patch.object(worker,'safe_json',return_value=snapshot):self.assertTrue(engine.ingest_terminal())
        secret='whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg='
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('fixture','fixture_principal',registry.canonical(self.args(['task_terminal'])),
             'https://callback.example.org/events',secret,None,0,self.now+86400,self.now,self.now-10,1))
        outcome=self.reg.dispatch_one();self.assertEqual(outcome['state'],'uncertain');self.assertFalse(outcome['assistant_run_confirmed'])
        receipt=self.reg.latest_delivery_receipt(self.now)
        self.assertEqual(receipt['members'][0]['terminal_state'],'not_dispatched')
        self.assertEqual(receipt['assistant_execution'],'unknown');self.assertFalse(receipt['functional_recovery_proven'])
        self.now+=601;self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM dispatch').fetchone()[0],1)

    def test_cached_future_native_completion_never_ingested(self):
        spec=importlib.util.spec_from_file_location('fixture_observer',Path(__file__).resolve().parent.parent/'task-terminal-observer'/'observer.py')
        observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
        op='c'*32;turn='22222222-2222-2222-2222-222222222222'
        row={'id':op,'task':'d'*32,'turn':turn,'state':'completed','updated':self.now-1,
             'result':json.dumps({'turn_id':turn,'operation_state':'completed','completed_at':self.now+60}),'reconciled':1}
        snapshot=observer.collect(lambda:([],[row]),lambda:True,now=lambda:self.now,scope_started_at=int(self.now)-60)
        self.assertEqual(snapshot['state'],'unknown');self.assertEqual(snapshot['events'],[])
        engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        with patch.object(worker,'safe_json',return_value=snapshot):self.assertFalse(engine.ingest_terminal())
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],0)

    def test_native_completion_unknown_null_is_accepted_without_time_invention(self):
        op='a'*32;opaque=hashlib.sha256(('task-terminal-operation-v1:'+op).encode()).hexdigest()
        event={'topic':'task_terminal','source':'registered_task_status','phase':'terminal','object_id':opaque,
               'revision':'b'*64,'observed_at':int(self.now),'operation_id':op,'terminal_state':'completed','result_updated_at':None}
        snapshot={'schema_version':1,'source':'registered_task_terminal_observer_v1','observed_at':summary.iso(self.now),
                  'state':'observed','collection_error':None,'scope_started_at':int(self.now)-10,'coverage':COVERAGE,'events':[event]}
        engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        with patch.object(worker,'safe_json',return_value=snapshot):self.assertTrue(engine.ingest_terminal())
        stored=json.loads(self.reg.db.execute('SELECT body FROM events').fetchone()[0])
        self.assertIsNone(stored['data']['result_updated_at'])

    def test_terminal_snapshot_scope_freshness_and_unknown_fail_closed(self):
        engine=worker.Engine(self.reg,1001,1001,clock=lambda:self.now)
        base={'schema_version':1,'source':'registered_task_terminal_observer_v1','observed_at':summary.iso(self.now),
              'state':'observed','collection_error':None,'scope_started_at':int(self.now)-10,'coverage':COVERAGE,'events':[]}
        cases=[{'state':'unknown'}, {'collection_error':'truncated'}, {'scope_started_at':int(self.now)+1},
               {'observed_at':summary.iso(self.now-121)}, {'events':[{}]*65}, {'source':'local_terminal_outbox'}]
        for change in cases:
            with self.subTest(change=change), patch.object(worker,'safe_json',return_value={**base,**change}):
                self.assertFalse(engine.ingest_terminal())
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],0)

    def test_terminal_identity_conflict_is_not_replayed(self):
        self.add('task_terminal','registered_task_status','terminal',1)
        op='a'*32;obj=hashlib.sha256(('task-terminal-operation-v1:'+op).encode()).hexdigest()
        revision=hashlib.sha256(b'1').hexdigest()
        with self.assertRaisesRegex(ValueError,'terminal_event_identity_conflict'):
            self.reg.enqueue('task_terminal','registered_task_status','terminal',obj,revision,self.now,op,'failed')
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],1)

    def test_legacy_uncertain_dispatch_never_replays_and_budget_remains_global(self):
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('fixture','fixture_principal',registry.canonical(self.args(['ha_notification'])),
             'https://callback.example.org/events','whsec_eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg=',None,0,self.now+86400,self.now,self.now-1,1))
        self.add('ha_notification','ha_persistent_notification','added')
        self.assertEqual(self.reg.dispatch_one()['state'],'uncertain')
        self.assertEqual(self.reg.dispatch_one()['state'],'budget_held')
        self.now+=601
        self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.reg.db.execute("SELECT count(*) FROM dispatch WHERE state='uncertain'").fetchone()[0],1)

if __name__ == '__main__': unittest.main()
