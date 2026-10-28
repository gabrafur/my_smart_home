import copy,hashlib,io,os,sys,tarfile,unittest
from pathlib import Path
from unittest.mock import patch
import source_image_audit as m
import test_maintenance_policy as fixture_module

def archive(data=None,name='mosquitto',extra=False):
    if data is None:
        data=bytearray(128);data[:6]=b'\x7fELF\x02\x01';data[18:20]=(183).to_bytes(2,'little');data=bytes(data)
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w')as t:
        row=tarfile.TarInfo(name);row.size=len(data);t.addfile(row,io.BytesIO(data))
        if extra:t.addfile(tarfile.TarInfo('unexpected'))
    return stream.getvalue(),data

class PureTests(unittest.TestCase):
    def test_binary_is_hashed_without_extracting_or_executing_it(self):
        raw,data=archive();self.assertEqual(m.binary_digest(raw),hashlib.sha256(data).hexdigest())
    def test_wrong_binary_architecture_and_archive_members_are_refused(self):
        for raw in [archive(b'not-an-ELF'*16)[0],archive(name='../mosquitto')[0],archive(extra=True)[0]]:
            with self.assertRaises(m.MaintenanceUnavailable):m.binary_digest(raw)
    def test_cached_image_requires_exact_arm64_digest_and_official_origin(self):
        image='sha256:'+'a'*64;repo='eclipse-mosquitto@sha256:'+'b'*64
        self.assertEqual(m.image_origin([image,'arm64','linux','["'+repo+'"]'],image),repo)
        for rows in [[image,'amd64','linux','[]'],[image,'arm64','linux','["private.invalid/image@sha256:'+'b'*64+'"]']]:
            with self.assertRaises(m.MaintenanceUnavailable):m.image_origin(rows,image)
    def test_subprocess_output_is_bounded_while_received(self):
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'output_bound'):
            m.bounded([sys.executable,'-I','-S','-B','-c','print("X"*100000)'],limit=1024)
    def test_subprocess_timeout_terminates_only_the_owned_child(self):
        with self.assertRaisesRegex(m.MaintenanceUnavailable,'command_deadline'):
            m.bounded([sys.executable,'-I','-S','-B','-c','import time;time.sleep(5)'],timeout=.1)

@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0,'requires isolated Root fixture; ordinary suite never escalates')
class RootTests(unittest.TestCase):
    write=fixture_module.Tests.write
    fake_run=fixture_module.Tests.fake_run
    def setUp(self):
        fixture_module.Tests.setUp(self)
        self.producer=m.Producer(self.journal.tx,self.backend,self.op)
        self.job={'schema_version':1,'source':'fixed_Root_mqtt_image_audit_job','operation_id':self.opid,
          'approval_sha256':'c'*64,'journal_head_sha256':self.op['records'][-1]['sha256'],
          'clock_domain_sha256':self.op['records'][0]['body']['clock_domain_sha256'],
          'issued_at_ns':'110','before_policy_sha256':hashlib.sha256(self.paths.policy.read_bytes()).hexdigest(),
          'target':self.candidate['target'],'image_id':'sha256:'+'d'*64,'broker_configuration_sha256':'f'*64}
        self.job_path=self.paths.policy.parent/'source-audit-job.json';self.write(self.job_path,self.job)
    def tearDown(self):fixture_module.Tests.tearDown(self)
    def test_job_accepts_only_fixed_schema_and_root_private_file(self):
        self.assertEqual(self.producer._job()[1],self.job)
        self.job_path.chmod(0o644)
        with self.assertRaises(m.MaintenanceUnavailable):self.producer._job()
    def test_job_cannot_retarget_or_renew_another_operation(self):
        for field,value in [('operation_id','e'*32),('journal_head_sha256','f'*64),('clock_domain_sha256','f'*64)]:
            d={**self.job,field:value};self.write(self.job_path,d)
            with self.assertRaises(m.MaintenanceUnavailable):self.producer._job()
        d={**self.job,'expires_at':None};self.write(self.job_path,d)
        with self.assertRaises(m.MaintenanceUnavailable):self.producer._job()
    def test_socket_path_bound_is_checked_before_any_probe_effect(self):
        paths=m.Paths(work=self.base/('x'*120));p=m.Producer(self.journal.tx,self.backend,self.op,paths)
        with patch.object(p,'_docker',side_effect=AssertionError('unexpected_effect')):
            with self.assertRaisesRegex(m.MaintenanceUnavailable,'socket_path_bound'):p.run()
        self.assertIsNone(p.receipt)
    def test_existing_intent_never_replays_a_native_audit(self):
        raw=self.job_path.read_bytes()
        self.producer.receipt={'schema_version':1,'operation_id':self.opid,'approval_sha256':'c'*64,
          'journal_head_sha256':self.job['journal_head_sha256'],'job_sha256':hashlib.sha256(raw).hexdigest(),
          'phase':'intent','probe_name':self.producer.probe,'probe_container_id':None,'effect_intents':['create'],
          'proof':None,'candidate':None,'candidate_before_hex':None,'cleanup_confirmed':False,'failure':None}
        self.producer._save()
        with patch.object(self.producer,'_docker',side_effect=AssertionError('unexpected_replay')):
            r=self.producer.run();self.assertEqual(r['state'],'image_audit_result_unconfirmed');self.assertFalse(r['dispatched'])
    def test_receipt_cannot_claim_completion_without_native_proof(self):
        raw=self.job_path.read_bytes()
        self.producer.receipt={'schema_version':1,'operation_id':self.opid,'approval_sha256':'c'*64,
          'journal_head_sha256':self.job['journal_head_sha256'],'job_sha256':hashlib.sha256(raw).hexdigest(),
          'phase':'candidate_written','probe_name':self.producer.probe,'probe_container_id':None,'effect_intents':[],
          'proof':None,'candidate':None,'candidate_before_hex':None,'cleanup_confirmed':True,'failure':None}
        self.producer._save()
        with self.assertRaises(m.MaintenanceUnavailable):self.producer.run()
