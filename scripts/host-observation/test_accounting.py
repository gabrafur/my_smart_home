import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import types
import unittest

spec=importlib.util.spec_from_file_location('accounting_observer',Path(__file__).with_name('observer.py'))
observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)

class AccountingTests(unittest.TestCase):
    def response(self,**changes):
        fields={'InvocationID':'a'*32,'CPUUsageNSec':'1000000','MemoryPeak':'[not set]',
            'ExecMainStartTimestampMonotonic':'1000','ExecMainExitTimestampMonotonic':'2000','Result':'success'}
        fields.update(changes)
        return types.SimpleNamespace(returncode=0,stdout=('\n'.join(k+'='+v for k,v in fields.items())+'\n').encode(),stderr=b'')

    def test_fixed_command_and_matching_identity_allow_native_CPU_only(self):
        calls=[]
        def run(args,**options):calls.append((args,options));return self.response()
        result=observer.procmon_accounting({'INVOCATION_ID':'a'*32},1000,run)
        self.assertEqual(result['state'],'observed');self.assertEqual(result['cpu_usage_ns'],1000000)
        self.assertIsNone(result['memory_peak_bytes'])
        self.assertEqual(result['memory_collection_error'],'memory_controller_or_metric_unavailable')
        self.assertEqual(result['collector_invocation_id_sha256'],hashlib.sha256(('a'*32).encode()).hexdigest())
        self.assertEqual(calls[0][0][:5],['/usr/bin/prlimit','--as=536870912','/usr/bin/systemctl','show','raspberry-procmon.service'])
        self.assertEqual(calls[0][1]['timeout'],2)
        self.assertNotIn('a'*32,json.dumps(result));self.assertLessEqual(len(json.dumps(result,separators=(',',':')).encode())+1,768)

    def test_missing_identity_never_executes(self):
        for value in [{},None,{'INVOCATION_ID':'PRIVATE_SENTINEL'}]:
            result=observer.procmon_accounting(value,1000,lambda *a,**kw:self.fail('must not run'))
            self.assertEqual(result['state'],'unknown');self.assertIsNone(result['cpu_usage_ns'])

    def test_conflicting_identity_invalid_counter_or_dates_are_unknown(self):
        for changes in [{'InvocationID':'b'*32},{'CPUUsageNSec':'PRIVATE_SENTINEL'},
                {'CPUUsageNSec':'18446744073709551615'},{'ExecMainExitTimestampMonotonic':'999'},
                {'ExecMainStartTimestampMonotonic':'0'}]:
            result=observer.procmon_accounting({'INVOCATION_ID':'a'*32},1000,lambda *a,**kw:self.response(**changes))
            self.assertEqual(result['state'],'unknown');self.assertIsNone(result['cpu_usage_ns'])
            self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))

    def test_collection_failure_has_no_control_or_raw_error_export(self):
        def failed(*a,**kw):raise subprocess.TimeoutExpired('PRIVATE_SENTINEL',2)
        result=observer.procmon_accounting({'INVOCATION_ID':'a'*32},1000,failed)
        self.assertEqual(result['state'],'unknown');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
        result=observer.procmon_accounting({'INVOCATION_ID':'a'*32},1000,lambda *a,**kw:types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'PRIVATE_SENTINEL'))
        self.assertEqual(result['state'],'unknown')

    def test_memory_zero_is_reported_only_when_native_metric_exists(self):
        result=observer.procmon_accounting({'INVOCATION_ID':'a'*32},1000,lambda *a,**kw:self.response(MemoryPeak='0'))
        self.assertEqual(result['state'],'observed');self.assertEqual(result['memory_peak_bytes'],0)
        self.assertIsNone(result['memory_collection_error'])

if __name__=='__main__':unittest.main()
