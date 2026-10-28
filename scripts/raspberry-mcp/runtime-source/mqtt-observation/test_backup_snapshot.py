"""Synthetic Root file capture/stream; no application or provider effects."""
from pathlib import Path
import base64,fcntl,io,json,os,tempfile,unittest
from unittest.mock import patch
import backup_snapshot as module
from worker import Paths
from handoff_ledger import HandoffLedger
from maintenance_journal import Journal,PHASES,canonical
from test_maintenance_journal import facts,H,DOMAIN
from test_protocol import frame

class Protocol(unittest.TestCase):
    def test_only_fixed_data_and_derived_history_paths_are_accepted(self):
        for name in ['../private','data/authorization.json','history/policy.json','history/binding-../private.json','history/maintenance.json/extra','data//state.sqlite3']:
            with self.assertRaises(module.RecoveryUnavailable):module.file_limit(name)
        self.assertEqual(module.file_limit('data/state.sqlite3'),1048576)
        self.assertEqual(module.file_limit('history/binding-'+'a'*32+'.json'),65536)

@unittest.skipUnless(os.geteuid()==os.getegid()==0,'isolated Root fixture required; ordinary suite never escalates')
class Root(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.base.chmod(0o700)
        self.paths=Paths(self.base/'state',self.base/'runtime',self.base/'reports',self.base/'consumer',self.base/'maintenance')
        for p,uid,gid,mode in [(self.paths.state,0,0,0o700),(self.paths.runtime,0,0,0o755),
            (self.paths.report,0,1000,0o750),(self.paths.consumer,1000,1000,0o700),(self.paths.maintenance,0,0,0o700)]:
            p.mkdir(mode=mode);p.chmod(mode);os.chown(p,uid,gid)
        self.ledger=HandoffLedger(self.paths.ledger,create=True,clock_domain_id=DOMAIN,started_ns=100)
        self.ledger.frame(json.dumps(frame()).encode(),300,source_binding_verified=True)
        for name,data in [('state.json',b'{"synthetic":1}'),('ack.json',b'{"synthetic_ack":1}'),('lock',b'')]:
            p=self.paths.consumer/name;p.write_bytes(data);p.chmod(0o600);os.chown(p,1000,1000)
        self.journal=Journal(self.paths.maintenance,H);self.operation_id='e'*32
        for phase in PHASES[:PHASES.index('consumer_stopped')+1]:
            op=self.journal.find(self.operation_id)
            self.journal.append(self.operation_id,phase,facts(phase),at_ns=str(100+PHASES.index(phase)),
              clock_domain_sha256=DOMAIN,expected_previous_sha256=op['records'][-1]['sha256']if op else None)
        self.destination=self.base/'snapshot';self.checks=0
    def tearDown(self):self.journal.close();self.ledger.close();self.temp.cleanup()
    def boundary(self):self.checks+=1
    def prepare(self):return module.prepare(self.paths,self.journal,self.destination,self.operation_id,self.boundary)
    def test_complete_capture_and_stream_keep_grants_out_and_preserve_source_bytes(self):
        (self.paths.state/'authorization.json').write_text('PRIVATE_AUTHORITY_SENTINEL')
        before=self.journal.status();value=self.prepare();self.assertEqual(self.checks,2)
        self.assertEqual(module.artifact(self.destination,self.operation_id),value)
        self.assertFalse(value['current_authority_included']);self.assertFalse(value['full24h_proven'])
        out=io.BytesIO();module.stream(self.destination,self.operation_id,out)
        frames=[json.loads(s)for s in out.getvalue().splitlines()]
        self.assertEqual(frames[0]['frame'],'begin');self.assertEqual(frames[-1]['frame'],'complete')
        self.assertEqual(frames[-1]['metadata'],{k:v for k,v in value.items()if k!='files'})
        self.assertEqual(frames[-1]['files'],len(value['files']));self.assertNotIn(b'PRIVATE_AUTHORITY_SENTINEL',out.getvalue())
        self.assertEqual(self.journal.status(),before)
        rebuilt={};current=None
        for message in frames[1:-1]:
            if message['frame']=='file':current=message['path'];rebuilt[current]=b''
            elif message['frame']=='chunk':
                self.assertEqual(message['offset'],len(rebuilt[current]));rebuilt[current]+=base64.b64decode(message['data'])
        self.assertEqual(set(rebuilt),{r['path']for r in value['files']})
        for name,data in rebuilt.items():self.assertEqual(data,(self.destination/name).read_bytes())
    def test_failure_at_final_boundary_keeps_partial_copy_without_publishable_manifest(self):
        def boundary():
            self.checks+=1
            if self.checks==2:raise RuntimeError('synthetic_boundary_failure')
        with self.assertRaisesRegex(RuntimeError,'synthetic_boundary_failure'):
            module.prepare(self.paths,self.journal,self.destination,self.operation_id,boundary)
        self.assertTrue((self.destination/'data/state.sqlite3').exists())
        self.assertFalse((self.destination/'backup-snapshot.json').exists())
        with self.assertRaises(FileExistsError):self.prepare()
    def test_existing_complete_snapshot_is_immutable_not_recaptured(self):
        value=self.prepare();before=(self.destination/'backup-snapshot.json').read_bytes()
        with self.assertRaises(FileExistsError):self.prepare()
        self.assertEqual((self.destination/'backup-snapshot.json').read_bytes(),before)
        self.assertEqual(module.artifact(self.destination,self.operation_id),value)
    def test_tamper_extra_authority_and_wrong_operation_refuse_export(self):
        self.prepare();p=self.destination/'data/consumer-state.json';raw=p.read_bytes();p.write_bytes(b'changed')
        with self.assertRaises(module.RecoveryUnavailable):module.stream(self.destination,self.operation_id,io.BytesIO())
        p.write_bytes(raw);extra=self.destination/'history/authorization.json';extra.write_text('PRIVATE');extra.chmod(0o600)
        with self.assertRaisesRegex(module.RecoveryUnavailable,'inventory_changed'):module.artifact(self.destination,self.operation_id)
        extra.unlink()
        with self.assertRaises(module.RecoveryUnavailable):module.artifact(self.destination,'f'*32)
    def test_size_bound_never_publishes_manifest(self):
        with patch.object(module,'MAX_BYTES',1):
            with self.assertRaisesRegex(module.RecoveryUnavailable,'capacity'):self.prepare()
        self.assertFalse((self.destination/'backup-snapshot.json').exists())
    def test_unstopped_phase_refused_before_destination_creation(self):
        with patch.object(self.journal,'find',return_value={'records':[{'body':{'phase':'begin'}}]}):
            with self.assertRaisesRegex(module.RecoveryUnavailable,'boundary_changed'):self.prepare()
        self.assertFalse(self.destination.exists())
    def test_busy_consumer_never_publishes_a_manifest(self):
        fd=os.open(self.paths.consumer/'lock',os.O_RDONLY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(module.RecoveryUnavailable,'consumer_busy'):self.prepare()
            self.assertFalse((self.destination/'backup-snapshot.json').exists())
        finally:os.close(fd)
    def test_timestamp_contract_requires_a_complete_UTC_instant(self):
        self.prepare();p=self.destination/'backup-snapshot.json';original=json.loads(p.read_bytes())
        for stamp in ['2026','2026-10-28T10:00:00+01:00',True]:
            p.write_bytes(canonical({**original,'captured_at_utc':stamp}))
            with self.assertRaises(module.RecoveryUnavailable):module.artifact(self.destination,self.operation_id)

if __name__=='__main__':unittest.main()
