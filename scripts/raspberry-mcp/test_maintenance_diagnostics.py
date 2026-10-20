import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import maintenance_diagnostics as d
from operations import Broker

class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        root=Path(self.temp.name)
        (root/'nodered/tools/functions').mkdir(parents=True)
        self.source=root/'nodered/tools/functions/example.js'
        self.source.write_text('module.exports = 1;\n')
        self.state=root/'state';self.state.mkdir()
        self.key='a'*32
        self.broker=Broker(root,self.state,{self.key:{'path':'nodered/tools/functions/example.js','sha256':hashlib.sha256(self.source.read_bytes()).hexdigest()}})
        self.addCleanup(self.temp.cleanup)
    def proposal(self,new='module.exports = 2;'):
        return self.broker.handle('project_prepare_edit',{'host':'raspberry','file_id':self.key,
          'expected_sha256':hashlib.sha256(self.source.read_bytes()).hexdigest(),
          'old_text':'module.exports = 1;', 'new_text':new})['change_id']
    def test_old_evidence_is_stale(self):
        self.assertEqual(d.evidence('fixture',{},'healthy',observed=10,now=200)['state'],'stale')
    def test_error_is_unknown(self):
        row=d.collect('fixture',lambda: (_ for _ in ()).throw(OSError('SECRET')),[])
        self.assertEqual(row['state'],'unknown');self.assertNotIn('SECRET',json.dumps(row))
    def test_scope_rejected(self):
        for args in ({'host':'other'},{'host':'raspberry','path':'/etc/passwd'}):
            with self.assertRaises(ValueError):d.handle(self.broker,'host_diagnostics',args)
    def test_discovery_has_no_new_write(self):
        row=d.handle(self.broker,'maintenance_capabilities',{'host':'raspberry'})
        self.assertEqual(row['evidence']['data']['write_scope_added'],[])
    def test_memory_partial_is_error(self):
        with self.assertRaises(ValueError):d.memory(lambda _: 'MemTotal: 20 kB')
    def test_cpu_avoids_double_count_guest(self):
        rows=iter(['cpu 100 0 0 100 0 0 0 0 90 0','cpu 110 0 0 110 0 0 0 0 100 0'])
        self.assertEqual(d.cpu(lambda _:next(rows),lambda _:None)['busy_percent'],50)
    def test_cpu_reset_is_error(self):
        with self.assertRaises(ValueError):d.cpu(lambda _:'cpu 1 1 1 1 1 1 1 1',lambda _:None)
    def test_running_without_health_not_healthy(self):
        row=d.service_diagnostics('mosquitto',lambda _: 'running|none|3|2026-10-19T00:00:00Z|false|0')
        self.assertEqual(row['container']['state'],'unknown')
        self.assertEqual(row['functional_readiness']['state'],'unknown')
    def test_failed_service(self):
        row=d.service_diagnostics('nodered',lambda _: 'exited|none|3|2026-10-19T00:00:00Z|true|137')
        self.assertEqual(row['container']['state'],'failed')
    def test_no_other_service(self):
        with self.assertRaises(ValueError):d.service_diagnostics('other')
    def test_runtime_private_output_blocked(self):
        row=d.service_diagnostics('nodered',lambda _: 'SECRET')
        self.assertNotIn('SECRET',json.dumps(row))
    def test_status_hides_payload(self):
        key=self.proposal()
        row=d.operation_status(self.broker,key)
        self.assertNotIn('module.exports',json.dumps(row))
        self.assertEqual(row['data']['status'],'prepared')
    def test_status_rejects_path(self):
        with self.assertRaises(ValueError):d.operation_status(self.broker,'../../etc/passwd')
    def test_symlink_rejected(self):
        target=self.state/('change-'+'b'*32+'.json');target.symlink_to(self.source)
        with self.assertRaises(OSError):d.operation_status(self.broker,'b'*32)
    def test_validate_no_execute(self):
        key=self.proposal('throw new Error("MUST_NOT_EXECUTE");')
        before=self.source.read_bytes()
        row=d.change_validate(self.broker,key)
        self.assertEqual(row['data']['status'],'passed')
        self.assertEqual(self.source.read_bytes(),before)
        self.assertEqual(self.broker.load('change-'+key+'.json')['status'],'prepared')
    def test_invalid_syntax_fails(self):
        row=d.change_validate(self.broker,self.proposal('module.exports = ;'))
        self.assertEqual(row['data']['status'],'failed')
    def test_concurrent_edit_blocks_validation(self):
        key=self.proposal();self.source.write_text('unrelated work')
        with self.assertRaises(ValueError):d.change_validate(self.broker,key)
    def test_timeout_unknown(self):
        import subprocess
        def timeout(*args):raise subprocess.TimeoutExpired('node',5)
        row=d.change_validate(self.broker,self.proposal(),timeout)
        self.assertEqual(row['data']['status'],'unknown')
    def test_expired_proposal_rejected(self):
        key=self.proposal();row=self.broker.load('change-'+key+'.json');row['created_at']=0;self.broker.save('change-'+key+'.json',row)
        with self.assertRaises(ValueError):d.change_validate(self.broker,key)
    def test_validation_does_not_authorize_contained_file_apply(self):
        key=self.proposal()
        before=self.source.read_bytes()
        self.assertEqual(d.change_validate(self.broker,key)['data']['status'],'passed')
        with self.assertRaisesRegex(ValueError,'atomic_compare_replace_unavailable'):
            self.broker.handle('change_apply',{'host':'raspberry','change_id':key})
        self.assertFalse(d.operation_status(self.broker,key)['data']['source_matches_proposal'])
        self.assertEqual(self.source.read_bytes(),before)

if __name__=='__main__':unittest.main()
