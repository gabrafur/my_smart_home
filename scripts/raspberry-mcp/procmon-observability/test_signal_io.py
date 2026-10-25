import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

BASE=Path(__file__).parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

wrapper=load('signal_io_observer',BASE.parent/'runtime-source/procmon-observability/observed_collector.py')

class SignalIOTests(unittest.TestCase):
    def collector(self):
        return load('signal_io_original_fixture',BASE/'collector.source.py')

    def test_os_and_signal_adapters_do_not_mutate_process_modules(self):
        mod=self.collector();old_fsync=os.fsync;old_register=signal.signal
        observer=wrapper.Observer();observer.install(mod)
        self.assertIs(os.fsync,old_fsync);self.assertIs(signal.signal,old_register)
        self.assertIsNot(mod.os,os);self.assertIsNot(mod.signal,signal)
        self.assertIs(mod.os.open,os.open);self.assertIs(mod.signal.alarm,signal.alarm)
        self.assertEqual(mod.signal.SIGALRM,signal.SIGALRM)

    def test_original_limits_alarm_and_handler_are_preserved_without_real_signals(self):
        mod=self.collector();handlers={};alarms=[];limits=[]
        mod.signal=types.SimpleNamespace(**vars(signal))
        def register(sig,handler):handlers[sig]=handler;return signal.SIG_DFL
        mod.signal.signal=register;mod.signal.alarm=alarms.append
        mod.resource=types.SimpleNamespace(**vars(mod.resource))
        mod.resource.getrlimit=lambda key:(mod.resource.RLIM_INFINITY,mod.resource.RLIM_INFINITY)
        mod.resource.setrlimit=lambda key,value:limits.append((key,value))
        observer=wrapper.Observer();observer.install(mod);mod.apply_limits()
        self.assertEqual(alarms,[5])
        self.assertEqual([v[1][0]for v in limits],[67108864,2,1048576,32])
        for sig,name in [(signal.SIGALRM,'SIGALRM'),(signal.SIGTERM,'SIGTERM')]:
            observer.stage='publish_snapshot'
            with self.assertRaisesRegex(TimeoutError,'collection_interrupted'):
                handlers[sig](sig,None)
            self.assertEqual(observer.signal_observations[-1]['signal'],name)
            self.assertEqual(observer.signal_observations[-1]['phase'],'publish_snapshot')
        # Installing/observing never rearms or extends the original alarm.
        self.assertEqual(alarms,[5])

    def test_file_and_directory_fsync_are_observed_without_changing_output(self):
        mod=self.collector();observer=wrapper.Observer();observer.install(mod)
        with tempfile.TemporaryDirectory()as directory:
            path=Path(directory)/'sample.json';mod.atomic(path,{'value':1})
            self.assertEqual(json.loads(path.read_text()),{'value':1})
            self.assertEqual(observer.fsync_calls,2)
            self.assertIsNone(observer.first_io_failure)
            self.assertIsNone(observer.active_io)
        result=observer.result()
        self.assertGreaterEqual(result['process_total_cpu_us'],result['cpu_us'])
        self.assertEqual(result['signals_observed'],[])
        self.assertLessEqual(len(json.dumps(result,separators=(',',':')).encode())+1,768)

    def test_interruption_at_fsync_records_kind_and_propagates_same_exception(self):
        mod=self.collector();handlers={}
        mod.signal=types.SimpleNamespace(**vars(signal))
        mod.signal.signal=lambda sig,handler:handlers.update({sig:handler})
        mod.os=types.SimpleNamespace(**vars(os))
        def failing(fd):return handlers[signal.SIGALRM](signal.SIGALRM,None)
        mod.os.fsync=failing
        observer=wrapper.Observer();observer.install(mod)
        def original(signum,frame):raise TimeoutError('collection_interrupted')
        mod.signal.signal(signal.SIGALRM,original)
        with tempfile.TemporaryDirectory()as directory:
            path=Path(directory)/'snapshot.json'
            with self.assertRaisesRegex(TimeoutError,'collection_interrupted'):mod.atomic(path,{})
            self.assertFalse(path.exists())
        self.assertEqual(observer.first_io_failure,{'operation':'fsync_regular_file','phase':'publish_snapshot'})
        self.assertEqual(observer.signal_observations[0]['io_operation'],'fsync_regular_file')
        self.assertIsNone(observer.active_io)
        row=observer.result(TimeoutError('collection_interrupted'))
        self.assertEqual(row['phase'],'publish_snapshot')
        self.assertLessEqual(len(json.dumps(row,separators=(',',':')).encode())+1,768)

    def test_two_signal_and_io_failure_record_stays_within_existing_frame_limit(self):
        observer=wrapper.Observer();observer.stage='preserve_interrupted'
        observer.fsync_calls=10;observer.fsync_wall_ms=7000;observer.fsync_max_wall_ms=7000
        observer.first_io_failure={'operation':'fsync_regular_file','phase':observer.stage}
        observer.signal_count=2
        observer.signal_observations=[{'signal':name,'phase':observer.stage,
            'io_operation':'fsync_regular_file','io_elapsed_ms':7000}for name in ['SIGALRM','SIGTERM']]
        row=observer.result(TimeoutError('collection_interrupted'))
        self.assertLessEqual(len(json.dumps(row,separators=(',',':')).encode())+1,768)

    def test_unknown_exception_text_and_descriptors_are_not_exported(self):
        observer=wrapper.Observer();row=observer.result(OSError('PRIVATE_SENTINEL'))
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(row))
        self.assertNotIn('fd',row)
        self.assertEqual(row['reason'],'unclassified')

    def test_signal_observation_is_bounded_and_default_handlers_are_passed_through(self):
        mod=self.collector();seen=[];handlers={}
        mod.signal=types.SimpleNamespace(**vars(signal))
        def register(sig,handler):seen.append(handler);handlers[sig]=handler;return signal.SIG_DFL
        mod.signal.signal=register
        observer=wrapper.Observer();observer.install(mod)
        def original(signum,frame):return None
        mod.signal.signal(signal.SIGTERM,original)
        for _ in range(10):handlers[signal.SIGTERM](signal.SIGTERM,None)
        self.assertEqual(observer.signal_count,10);self.assertEqual(len(observer.signal_observations),2)
        mod.signal.signal(signal.SIGTERM,signal.SIG_DFL)
        self.assertIs(seen[-1],signal.SIG_DFL)

if __name__=='__main__':unittest.main()
