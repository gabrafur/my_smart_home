import importlib.util
import sys
from unittest.mock import patch
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import ssl
import tempfile
import unittest

ROOT=Path(__file__).parent

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file)
    result=importlib.util.module_from_spec(spec);sys.modules[name]=result;spec.loader.exec_module(result);return result

history=module('heartbeat_category_history','history.py')
webhook=module('heartbeat_category_webhook','webhook.py')
identity=module('heartbeat_category_identity','loaded_identity.py')
with patch.dict(sys.modules,{'history':history,'webhook':webhook,'loaded_identity':identity}):
    heartbeat=module('heartbeat_category_sender','heartbeat.py')
send_once=heartbeat.send_once
History=history.History

IDENTIFIER='11111111-1111-4111-8111-111111111111'

class HeartbeatDiagnostics(unittest.TestCase):
    def test_exception_categories_are_closed_single_attempt_and_no_private_text(self):
        cases=[(socket.gaierror('private sentinel'),'dns_resolution_error'),
               (ssl.SSLCertVerificationError('private sentinel'),'tls_certificate_error'),
               (ssl.SSLError('private sentinel'),'tls_error'),
               (TimeoutError('private sentinel'),'timeout_exception'),
               (ConnectionResetError('private sentinel'),'connection_error'),
               (http.client.BadStatusLine('private sentinel'),'http_protocol_error'),
               (OSError('private sentinel'),'os_error'),
               (ValueError('private sentinel'),'transport_exception_unclassified')]
        for error,category in cases:
            calls=[]
            def fail(*args):calls.append(1);raise error
            result=send_once(IDENTIFIER,fail,lambda:1800000000)
            self.assertEqual(calls,[1]);self.assertEqual(result['state'],'uncertain')
            self.assertEqual(result['failure_category'],category)
            self.assertNotIn('private sentinel',json.dumps(result))
            self.assertNotIn(IDENTIFIER,json.dumps(result))
            self.assertFalse(result['automatic_retry'])

    def test_success_and_refusal_distinguish_http_and_body_without_export(self):
        for status,body,category in [(200,b'OK',None),(200,b'private sentinel','unexpected_provider_response'),(503,b'private sentinel','http_refused')]:
            result=send_once(IDENTIFIER,lambda *args:(status,body),lambda:1800000000)
            self.assertEqual(result['failure_category'],category)
            self.assertEqual(result['state'],'provider_accepted' if category is None else 'provider_refused')
            self.assertNotIn('private sentinel',json.dumps(result))

class HistoryDiagnostics(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();os.chmod(self.tmp.name,0o700)
        self.now=1800000000.0;self.history=History(self.tmp.name,clock=lambda:self.now)
    def tearDown(self):self.history.close();self.tmp.cleanup()
    def result(self,state='uncertain',category='timeout_exception'):
        return {'state':state,'http_status':200 if state=='provider_accepted' else None,'duration_ms':5,'failure_category':category}

    def test_old_failure_stays_not_recorded_after_later_success(self):
        old=self.history.begin();self.history.finish(old,{'state':'uncertain','http_status':None,'duration_ms':8})
        self.now+=60;new=self.history.begin();self.history.finish(new,self.result('provider_accepted',None))
        result=self.history.summary();self.assertEqual(result['last_sample_state'],'provider_accepted')
        self.assertEqual(result['latest_failed_or_uncertain_sample']['failure_category'],'not_recorded')
        self.assertFalse(result['latest_failed_or_uncertain_sample']['is_latest_attempt'])
        self.assertTrue(result['latest_failed_or_uncertain_sample']['sample_completion_recorded'])

    def test_failure_after_success_is_current_with_safe_category(self):
        old=self.history.begin();self.history.finish(old,self.result('provider_accepted',None))
        self.now+=60;new=self.history.begin();self.history.finish(new,self.result())
        result=self.history.summary();self.assertEqual(result['last_sample_state'],'uncertain')
        self.assertEqual(result['latest_failed_or_uncertain_sample']['failure_category'],'timeout_exception')
        self.assertTrue(result['latest_failed_or_uncertain_sample']['is_latest_attempt'])

    def test_failure_category_and_result_are_atomic(self):
        sample=self.history.begin()
        self.history.db.execute("CREATE TRIGGER inject_fault BEFORE INSERT ON failure_diagnostics BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.history.finish(sample,self.result())
        row=self.history.db.execute('SELECT state,duration_ms FROM samples WHERE id=?',(sample,)).fetchone()
        self.assertEqual(row,('uncertain',None))
        self.assertEqual(self.history.db.execute('SELECT count(*) FROM failure_diagnostics').fetchone()[0],0)

    def test_restart_preserves_same_sample_and_prevents_finish_twice(self):
        sample=self.history.begin();self.history.finish(sample,self.result())
        self.history.close();self.history=History(self.tmp.name,clock=lambda:self.now)
        self.assertEqual(self.history.summary()['latest_failed_or_uncertain_sample']['failure_category'],'timeout_exception')
        with self.assertRaisesRegex(ValueError,'sample_already_finished'):self.history.finish(sample,self.result())

    def test_unfinished_sample_does_not_invent_transport_cause(self):
        self.history.begin();result=self.history.summary()
        self.assertEqual(result['latest_failed_or_uncertain_sample']['failure_category'],'not_recorded')
        self.assertFalse(result['latest_failed_or_uncertain_sample']['sample_completion_recorded'])

    def test_unknown_private_or_conflicting_category_rejected_before_effects(self):
        sample=self.history.begin()
        for value in ['private sentinel',{},['timeout_exception']]:
            with self.assertRaises(ValueError):self.history.finish(sample,self.result(category=value))
        with self.assertRaisesRegex(ValueError,'conflicting_failure_category'):
            self.history.finish(sample,self.result('provider_accepted','timeout_exception'))
        self.assertIsNone(self.history.db.execute('SELECT duration_ms FROM samples').fetchone()[0])

    def test_retention_removes_only_orphan_diagnostics_and_sequence_never_resets(self):
        sample=self.history.begin();self.history.finish(sample,self.result())
        self.now+=8*86400;new=self.history.begin()
        self.assertNotEqual(sample,new)
        self.assertEqual(self.history.db.execute('SELECT count(*) FROM failure_diagnostics').fetchone()[0],0)
        self.assertEqual(self.history.summary()['last_sequence'],2)

    def test_status_has_no_identifier_or_private_body_and_no_snapshot_side_effect(self):
        sample=self.history.begin();self.history.finish(sample,self.result());before=list(self.history.db.iterdump())
        result=self.history.summary();self.assertNotIn(sample,json.dumps(result));self.assertNotIn(IDENTIFIER,json.dumps(result))
        self.assertEqual(before,list(self.history.db.iterdump()))
        self.history.publish_status();value=json.loads((Path(self.tmp.name)/'status.json').read_text())
        self.assertEqual(value['diagnostic_schema_version'],3)

    def test_legacy_six_column_table_remains_unchanged_and_readable(self):
        sample=self.history.begin();self.history.finish(sample,{'state':'provider_refused','http_status':503,'duration_ms':8})
        self.history.db.execute('DROP TABLE failure_diagnostics')
        self.history.close();self.history=History(self.tmp.name,clock=lambda:self.now)
        names=[row[1] for row in self.history.db.execute('PRAGMA table_info(samples)')]
        self.assertEqual(names,['seq','id','at','state','http','duration_ms'])
        self.assertEqual(self.history.summary()['latest_failed_or_uncertain_sample']['failure_category'],'not_recorded')

if __name__=='__main__':unittest.main()
