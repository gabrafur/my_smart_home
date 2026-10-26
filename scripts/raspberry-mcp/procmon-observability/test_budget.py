"""Deterministic pure envelope tests: no real signal, collector, filesystem I/O or wait."""
import ast,contextlib,importlib.util,json,stat,types,unittest
from pathlib import Path
from unittest.mock import patch,Mock
P=Path(__file__).parent;s=importlib.util.spec_from_file_location('fixed_budget_observer',P.parent/'runtime-source/procmon-observability/observed_collector.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Cases(unittest.TestCase):
 def fixture(self):
  clock=[0.0];trace=[];handlers={};counters={'limits':0,'sample':0,'run':0}
  original_handler=lambda signum,frame:(_ for _ in()).throw(TimeoutError('collection_interrupted'))
  def register(number,handler):handlers[number]=handler
  signal=types.SimpleNamespace(SIGALRM=14,SIGTERM=15,signal=register,alarm=lambda seconds:trace.append(('alarm',seconds)))
  fakeos=types.SimpleNamespace(fsync=lambda fd:trace.append(('fsync',fd)),fstat=lambda fd:types.SimpleNamespace(st_mode=stat.S_IFREG|0o600),umask=lambda value:0o077)
  def sample():counters['sample']+=1;return {'safe':'fixture'}
  def cycle(state=None,sampler=sample):return sampler()
  mod=types.SimpleNamespace(os=fakeos,signal=signal,collect=sample,cycle=cycle,atomic=lambda *a,**k:None,prune=lambda *a,**k:None,preserve_interrupted=lambda *a,**k:None,STATE=Path('/synthetic'),MAX_SAMPLE=1048576)
  def limits():
   counters['limits']+=1;trace.append(('limits',None));mod.signal.signal(14,original_handler);mod.signal.signal(15,original_handler);mod.signal.alarm(5)
  def run():counters['run']+=1;return mod.cycle()
  mod.apply_limits=limits;mod.run_once=run
  return mod,clock,trace,handlers,counters,original_handler
 def deterministic(self,clock):
  stack=contextlib.ExitStack();stack.enter_context(patch.object(m.time,'monotonic',lambda:clock[0]));stack.enter_context(patch.object(m.resource,'getrusage',return_value=types.SimpleNamespace(ru_utime=0.0,ru_stime=0.0,ru_maxrss=1)));return stack
 def test_original_limits_once_then_fixed15_without_sampling(self):
  mod,clock,trace,handlers,count,handler=self.fixture()
  with self.deterministic(clock):observer=m.Observer();observer.install(mod);m.apply_observed_limits(mod)
  self.assertEqual(trace,[('limits',None),('alarm',5),('alarm',15)]);self.assertEqual(count,{'limits':1,'sample':0,'run':0});self.assertEqual(set(handlers),{14,15})
  for registered in handlers.values():self.assertIs(dict(zip(registered.__code__.co_freevars,[c.cell_contents for c in registered.__closure__]))['handler'],handler)
 def test_bad_fixed_budget_types_values_refused_before_original_limits(self):
  for budget in (None,True,False,15.0,'15',5,14,16,100):
   mod,clock,trace,handlers,count,handler=self.fixture()
   with patch.object(m,'WALL_IO_ENVELOPE_SECONDS',budget):self.assertRaisesRegex(ValueError,'unsupported_wall_io_envelope',m.apply_observed_limits,mod)
   self.assertEqual(trace,[]);self.assertEqual(count['limits'],0);self.assertEqual(handlers,{})
 def test_original_limit_failure_propagates_without_rearm(self):
  mod,clock,trace,handlers,count,handler=self.fixture();error=OSError('fixture_failure');mod.apply_limits=Mock(side_effect=error)
  with self.assertRaises(OSError)as caught:m.apply_observed_limits(mod)
  self.assertIs(caught.exception,error);mod.apply_limits.assert_called_once();self.assertEqual(trace,[])
 def test_main_load_once_original_limits_once_single_sampler_and_success_emit(self):
  mod,clock,trace,handlers,count,handler=self.fixture()
  with self.deterministic(clock):
   observer=m.Observer();observer.emit=Mock()
   with patch.object(m,'Observer',return_value=observer),patch.object(m,'load_collector',return_value=mod)as loader,patch.object(m.os,'geteuid',return_value=1001),patch.object(m.sys,'argv',['fixed']):self.assertEqual(m.main(),0)
  loader.assert_called_once_with();self.assertEqual(count,{'limits':1,'sample':1,'run':1});observer.emit.assert_called_once_with();self.assertEqual(trace,[('limits',None),('alarm',5),('alarm',15)])
 def test_fsync_signal_receipt_and_original_interrupted_error_are_retained(self):
  mod,clock,trace,handlers,count,handler=self.fixture()
  def delayed_fake_fsync(fd):clock[0]=15.3;handlers[14](14,None)
  mod.os.fsync=delayed_fake_fsync
  with self.deterministic(clock):
   observer=m.Observer();observer.install(mod);m.apply_observed_limits(mod);observer.stage='write_history'
   with self.assertRaisesRegex(TimeoutError,'collection_interrupted'):mod.os.fsync(7)
   self.assertEqual(observer.fsync_calls,1);self.assertEqual(observer.fsync_max_wall_ms,15300);self.assertEqual(observer.first_io_failure,{'operation':'fsync_regular_file','phase':'write_history'})
   self.assertEqual(observer.signal_observations,[{'signal':'SIGALRM','phase':'write_history','io_operation':'fsync_regular_file','io_elapsed_ms':15300}]);self.assertEqual(m.classification(TimeoutError('collection_interrupted'))['reason'],'collection_interrupted')
 def test_alarm_setup_failure_fails_main_without_run_or_retry(self):
  mod,clock,trace,handlers,count,handler=self.fixture();old_alarm=mod.signal.alarm
  def alarm(seconds):
   if seconds==15:raise OSError('fixture_alarm_failure')
   return old_alarm(seconds)
  mod.signal.alarm=alarm
  with self.deterministic(clock):
   observer=m.Observer();observer.emit=Mock()
   with patch.object(m,'Observer',return_value=observer),patch.object(m,'load_collector',return_value=mod),patch.object(m.os,'geteuid',return_value=1001),patch.object(m.sys,'argv',['fixed']):self.assertEqual(m.main(),1)
  self.assertEqual(count,{'limits':1,'sample':0,'run':0});self.assertEqual(observer.emit.call_count,1);self.assertIsInstance(observer.emit.call_args.args[0],OSError)
 def test_root_or_extra_arguments_still_refused_before_import_limits_sampler(self):
  for uid,args in [(0,['fixed']),(1001,['fixed','free'])]:
   with patch.object(m,'Observer')as factory,patch.object(m,'load_collector')as loader,patch.object(m.os,'geteuid',return_value=uid),patch.object(m.sys,'argv',args):self.assertEqual(m.main(),1)
   loader.assert_not_called();self.assertEqual(factory.return_value.emit.call_count,1)
 def test_original_collector_identity_stays_pinned(self):
  import hashlib
  self.assertEqual(m.COLLECTOR_SHA,'d53a173123b0d6d96406e56bd73559fd5fd00d6dd040bf36cf2c21b978e1b277')
  self.assertEqual(hashlib.sha256((P/'collector.source.py').read_bytes()).hexdigest(),m.COLLECTOR_SHA)
 def test_unit_allows_wall_IO_without_relaxing_resource_or_network_limits(self):
  fields=dict(line.split('=',1)for line in (P/'raspberry-procmon.service').read_text().splitlines()if '='in line)
  expected={'TimeoutStartSec':'20','CPUQuota':'15%','LimitCPU':'2','LimitAS':'67108864','LimitFSIZE':'1048576','LimitNOFILE':'32','TasksMax':'4','PrivateNetwork':'yes','PrivateDevices':'yes','NoNewPrivileges':'yes','ProtectSystem':'strict','User':'raspberry-procmon','Group':'raspberry-procmon'}
  for key,value in expected.items():self.assertEqual(fields[key],value,key)
if __name__=='__main__':unittest.main()
