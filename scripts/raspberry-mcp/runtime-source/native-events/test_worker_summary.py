import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from registry import Registry
from worker import Engine


class WorkerSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();os.chmod(self.tmp.name,0o700)
        self.now=1800000000.0;self.sent=[]
        self.reg=Registry(self.tmp.name,'test_owner',approved=True,sender=self.send,clock=lambda:self.now)
        self.reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('sub','test_owner',json.dumps({'project':'/mnt/data/docker','topics':['ha_notification']}),
             'https://callback.example.org/events','whsec_'+base64.b64encode(b'x'*32).decode(),None,
             0,self.now+86400,self.now,self.now-1000,1))
        self.snapshot=Path(self.tmp.name)/'snapshot.json'
        self.engine=Engine(self.reg,os.getuid(),os.getuid(),snapshot=self.snapshot,clock=lambda:self.now)
        self.now+=1

    def tearDown(self):self.reg.db.close();self.tmp.cleanup()

    def send(self,url,headers,body):self.sent.append(json.loads(body));return 200,b''

    def write(self,events,notifications=(),age=0,error=None):
        self.snapshot.write_text(json.dumps({'schema_version':1,'observed_at':self.iso(self.now-age),
          'connection_state':'subscribed','collection_error':error,'events':events,
          'notifications':list(notifications),'dropped':0}));self.snapshot.chmod(0o640)

    def iso(self,at):return datetime.datetime.fromtimestamp(at,datetime.timezone.utc).isoformat()

    def event(self,index=0,phase='added'):
        return {'source':'ha_persistent_notification','topic':'ha_notification','phase':phase,
          'object_id':'a'*64,'revision':hashlib.sha256(str(index).encode()).hexdigest(),'observed_at':self.iso(self.now)}

    def test_engine_fresh_snapshot_drives_current_state_once(self):
        self.write([self.event()], [{'id':'a'*64,'revision':'f'*64,'title':'PRIVATE_SENTINEL'}])
        self.engine.tick();self.engine.tick()
        self.assertEqual(len(self.sent),1)
        self.assertEqual(self.sent[0]['data']['notifications'][0]['current_state'],'current')
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(self.sent))
        self.assertEqual(self.reg.event_counts(self.now)['eligible_pending_event_records'],0)

    def test_removed_snapshot_reports_removed_not_recovered(self):
        self.write([self.event(0,'added'),self.event(1,'removed')])
        self.engine.tick()
        group=self.sent[0]['data']['notifications'][0]
        self.assertEqual(group['current_state'],'removed');self.assertFalse(group['recovery_proven'])

    def test_invalid_current_snapshot_no_enqueue_or_dispatch(self):
        self.write([self.event()], [{'id':'private-value','revision':'f'*64}])
        self.engine.tick()
        self.assertEqual(self.sent,[])
        self.assertEqual(self.reg.db.execute('SELECT count(*) FROM events').fetchone()[0],0)

    def test_stale_or_failed_snapshot_never_dispatches_old_queue(self):
        for age,error in [(16,None),(0,'auth_failed')]:
            self.write([self.event()],age=age,error=error);self.engine.tick()
        self.assertEqual(self.sent,[])

    def test_worker_uncertain_and_budget_persist_no_retry(self):
        self.write([self.event()]);self.engine.ingest()
        self.reg.sender=lambda *a:(_ for _ in ()).throw(TimeoutError())
        self.engine.tick();self.now+=601
        self.reg.sender=self.send;self.write([self.event()]);self.engine.tick()
        self.assertEqual(self.sent,[])
        self.assertEqual(self.reg.db.execute('SELECT state FROM dispatch').fetchone()[0],'uncertain')

    def test_natural_batch_intent_before_sender(self):
        def inspect(*args):
            self.assertEqual(self.reg.db.execute('SELECT state FROM dispatch').fetchone()[0],'uncertain')
            self.assertEqual(self.reg.db.execute('SELECT count(*) FROM delivery_members').fetchone()[0],1)
            return 200,b''
        self.reg.sender=inspect;self.write([self.event()]);self.engine.tick()
        self.assertFalse(self.engine.last_dispatch['assistant_run_confirmed'])

    def test_archive_pressure_reports_a_blocker_without_sending(self):
        from unittest.mock import patch
        from webhook import Refused
        with patch.object(self.reg,'prune',side_effect=Refused('event_history_archive_full')):
            self.engine.tick()
        self.assertEqual(self.engine.last_dispatch['reason'],'event_history_archive_full')
        self.assertEqual(self.sent,[])


if __name__=='__main__':unittest.main()
