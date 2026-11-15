"""Isolated tests; never points at the installed ledger or invokes a real RPC."""
import json
from pathlib import Path
import tempfile
import types
import unittest

from task_store import Store, incident_request, fingerprint
import task_list

OBJECT = 'a' * 64
REV = 'b' * 64
THREAD = '11111111-1111-1111-1111-111111111111'
TURN = '22222222-2222-2222-2222-222222222222'

def text(obj=OBJECT, rev=REV, ascii=False):
    return (f'Diagnostique e corrija somente o autorizado para objeto {obj} e '
            + (f'revisao {rev}; prepare os demais e reporte evidencias.' if ascii else
               f'revisão {rev}; prepare os demais e reporte evidências.'))

class IncidentBindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'jobs.sqlite3'
        self.store = Store(self.path, clock=lambda: 1000)
        self.store.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',
                              (OBJECT[:32], 'eva-workspace-' + OBJECT[:32], 'f'*64,
                               THREAD, 'created', 1, 1, 1))
        self.calls = []
    def tearDown(self):
        self.store.close(); self.tmp.cleanup()
    def invoke(self, request):
        self.calls.append(request['mode'])
        return {'operation_state':'accepted', 'turn_id':TURN}
    def send(self, obj=OBJECT, rev=REV, **kwargs):
        q={'operation_id':rev[-32:], 'task_id':OBJECT[:32], 'text':text(obj, rev, **kwargs)}
        return self.store.send(q, self.invoke, lambda *_:None, lambda:None)
    def release(self):
        self.store.db.execute("UPDATE sends SET state='completed',reconciled=1")
    def test_exact_templates_only(self):
        self.assertEqual(incident_request(text()), (OBJECT, REV))
        self.assertEqual(incident_request(text(ascii=True)), (OBJECT, REV))
        for other in (text()+' ', 'prefix '+text(), text().replace('a'*64, 'A'*64),
                      text().replace('evidências.', 'evidencias.')):
            self.assertIsNone(incident_request(other))
    def test_binding_is_atomic_and_status_exact(self):
        r=self.send(); self.assertEqual(r['incident_binding']['revision'], REV)
        self.assertEqual(r['incident_binding']['send_state'], 'accepted')
        task=self.store.row('tasks', OBJECT[:32])['incident_binding']
        self.assertEqual(task['object_id'], OBJECT)
        self.assertEqual(task['latest_recorded']['operation_id'], REV[-32:])
        self.assertEqual(task['provenance'], 'authenticated_request_binding_not_incident_cause_or_recovery')
        self.assertEqual(self.calls, ['send_preflight','send'])
        self.assertEqual(self.send()['duplicate'], True)
        self.assertEqual(self.calls, ['send_preflight','send'])
    def test_collision_and_recipe_refused_without_send_or_new_row(self):
        self.send(); self.release(); self.calls.clear()
        with self.assertRaisesRegex(ValueError, 'incident_object_collision'):
            self.send(obj='a'*32+'c'*32, rev='d'*64)
        self.assertEqual(self.calls, ['send_preflight'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sends').fetchone()[0], 1)
        with self.assertRaisesRegex(ValueError, 'incident_binding_recipe_mismatch'):
            self.store.send({'operation_id':'e'*32,'task_id':OBJECT[:32], 'text':text()},
                            self.invoke, lambda *_:None, lambda:None)
    def test_preflight_refusal_has_no_binding(self):
        def refused(_): raise ValueError('not_ready')
        result=self.store.send({'operation_id':REV[-32:],'task_id':OBJECT[:32], 'text':text()},
                               refused, lambda *_:None, lambda:None)
        self.assertEqual(result['state'], 'not_dispatched')
        self.assertEqual(result['incident_binding']['state'], 'unknown')
        self.assertEqual(self.store.row('tasks', OBJECT[:32])['incident_binding']['state'], 'unknown')
    def test_legacy_key_accepts_canonical_text_without_binding(self):
        self.store.db.execute("UPDATE tasks SET task_key='legacy-task' WHERE id=?", (OBJECT[:32],))
        result=self.send()
        self.assertEqual(result['state'], 'accepted')
        self.assertEqual(result['incident_binding']['state'], 'unknown')
        self.assertEqual(self.store.row('tasks', OBJECT[:32])['incident_binding']['state'], 'unknown')

    def test_intermediate_malformed_or_conflicting_binding_fails_closed(self):
        self.send(); self.release()
        other='d'*64
        self.send(rev=other); self.release()
        latest_seq=self.store.db.execute("SELECT seq FROM audit WHERE id=? AND state LIKE 'incident_binding_v1:%'", (other[-32:],)).fetchone()[0]
        last_seq=self.store.db.execute('SELECT max(seq) FROM audit').fetchone()[0]
        self.store.db.execute('UPDATE audit SET seq=? WHERE seq=?', (last_seq+2, latest_seq))
        self.store.db.execute("INSERT INTO audit(seq,id,state,at) VALUES(?,?,?,?)",
                              (last_seq+1, REV[-32:], 'incident_binding_v1:malformed', 1))
        with self.assertRaisesRegex(ValueError, 'invalid_incident_binding'):
            self.store.row('tasks', OBJECT[:32])
        self.store.db.execute("DELETE FROM audit WHERE state='incident_binding_v1:malformed'")
        self.store.db.execute("INSERT INTO audit(seq,id,state,at) VALUES(?,?,?,?)",
                              (last_seq+1, REV[-32:], 'incident_binding_v1:'+'a'*32+'c'*32+':'+REV, 1))
        with self.assertRaisesRegex(ValueError, 'incident_binding_conflict'):
            self.store.row('tasks', OBJECT[:32])

    def test_context_validation_and_matching_create_spec(self):
        context={'objective':'Investigue fatos autorizados', 'acceptance':'Reporte evidencias',
                 'incident':{'object_id':OBJECT,'revision':REV,'source':'observer',
                             'observed_at':'2026-11-15T01:02:03Z','collection_error':None,
                             'coverage':['retained'], 'summary':'Evento sanitizado'}}
        spec={'operation_id':OBJECT[:32], 'task_key':'eva-workspace-'+OBJECT[:32],
              'objective':context['objective'], 'acceptance':context['acceptance']}
        self.store.db.execute('UPDATE tasks SET spec_hash=?', (fingerprint(spec),))
        def attempt(body):
            return self.store.send({'operation_id':REV[-32:], 'task_id':OBJECT[:32], 'text':body},
                                   self.invoke, lambda *_:None, lambda:None)
        def body(value):return text(ascii=True)+'\n\nTASK_CONTEXT_V1\n'+json.dumps(value)
        bad=json.loads(json.dumps(context)); bad['incident']['revision']='c'*64
        with self.assertRaisesRegex(ValueError, 'incident_context_identity_mismatch'): attempt(body(bad))
        bad=json.loads(json.dumps(context)); bad['objective']='Alterado'
        with self.assertRaisesRegex(ValueError, 'incident_context_spec_mismatch'): attempt(body(bad))
        for key, value in [('source', 'x'*129), ('coverage',['x']*17),
                           ('observed_at','2026-02-30T01:02:03Z'), ('summary','x'*1001)]:
            bad=json.loads(json.dumps(context)); bad['incident'][key]=value
            with self.assertRaisesRegex(ValueError, 'incident_context_invalid'): attempt(body(bad))
        bad=json.loads(json.dumps(context)); bad['incident']['observed_att']=bad['incident'].pop('observed_at')
        with self.assertRaisesRegex(ValueError, 'incident_context_invalid'): attempt(body(bad))
        with self.assertRaisesRegex(ValueError, 'incident_context_invalid'):
            attempt(text()+'\n\nTASK_CONTEXT_V1\n{"objective":1,"objective":2}')
        result=attempt(body(context))
        self.assertEqual(result['incident_binding']['revision'],REV)
        self.assertNotIn(context['objective'], str(list(self.store.db.iterdump())))
        self.assertNotIn(context['incident']['summary'], str(list(self.store.db.iterdump())))

    def test_context_with_legacy_key_is_passed_without_binding(self):
        self.store.db.execute("UPDATE tasks SET task_key='legacy-task' WHERE id=?", (OBJECT[:32],))
        request={'operation_id':REV[-32:],'task_id':OBJECT[:32],
                 'text':text()+'\n\nTASK_CONTEXT_V1\nnot-json'}
        result=self.store.send(request, self.invoke, lambda *_:None, lambda:None)
        self.assertEqual(result['state'], 'accepted')
        self.assertEqual(result['incident_binding']['state'], 'unknown')

    def test_old_unknown_history_is_not_backfilled(self):
        self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?)',
                              ('c'*32,OBJECT[:32],'f'*64,'completed',TURN,1,1,None,1))
        self.assertEqual(self.store.row('sends','c'*32)['incident_binding']['state'], 'unknown')
        self.assertEqual(self.store.row('tasks',OBJECT[:32])['incident_binding']['state'], 'unknown')
    def test_list_queries_binding_beyond_recent_sends(self):
        self.send(); self.release()
        for n in range(1025):
            op=format(n+1,'032x')
            self.store.db.execute('INSERT INTO sends VALUES(?,?,?,?,?,?,?,?,?)',
                                  (op,OBJECT[:32],'f'*64,'completed',TURN,2+n,2+n,None,1))
        self.store.close()
        tasks=types.SimpleNamespace(STATE=Path(self.tmp.name), LEGACY_DB=Path(self.tmp.name)/'missing',
                                    read=lambda *args:None)
        rows,errors,truncated=task_list.registry(tasks, 3000)
        row=next(row for row in rows if row.get('task_id')==OBJECT[:32])
        self.assertEqual(row['incident_binding']['first_recorded']['revision'],REV)
        self.assertTrue(truncated)
        self.store=Store(self.path, clock=lambda:1000)

if __name__ == '__main__': unittest.main()
