"""Actual Docker create/start stdin transport; synthetic bytes, no mounts/network."""
import json,subprocess,sys
IMAGE='sha256:23f4dfbb69ce76315dbc4de7915504f1c2dcecd7ca2648113a493a385972e133'
LABEL='smart-home.offsite-stdin-synthetic'
def call(args,input=None):
 r=subprocess.run(['docker',*args],input=input,capture_output=True,timeout=30)
 if r.returncode!=0:raise RuntimeError('synthetic_container_operation_failed')
 if len(r.stdout)>4096 or len(r.stderr)>4096:raise RuntimeError('synthetic_output_limit')
 return r.stdout

def case(interactive):
 name='offsite-stdin-synthetic-20261026-'+('open'if interactive else'closed')
 created=False
 try:
  args=['create','--pull=never','--name',name,'--label',LABEL+'=fixed-test','--network','none','--user','1001:1001','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--pids-limit','8','--cpus','0.15','--ulimit','core=0:0']
  if interactive:args+=['--interactive']
  script="import json,sys;raw=sys.stdin.buffer.read(8193);print(json.dumps({'input_bytes':len(raw),'matches_synthetic_input':raw==b'SYNTHETIC_INPUT_ONLY\\n'}))"
  cid=call([*args,'--entrypoint','python',IMAGE,'-I','-S','-B','-c',script]).decode().strip();created=True
  binding=json.loads(call(['inspect','--format','{{json .Config}}',cid]));assert binding['Labels'].get(LABEL)=='fixed-test';open_stdin=binding['OpenStdin']
  out=json.loads(call(['start','--attach','--interactive',cid],input=b'SYNTHETIC_INPUT_ONLY\n'))
  assert out['input_bytes']==(21 if interactive else 0),out
  assert out['matches_synthetic_input']is interactive
  return {'create_interactive':interactive,'OpenStdin':open_stdin,**out}
 finally:
  if created:
   data=call(['inspect','--format','{{json .Config.Labels}} {{.Image}}',name]).decode().strip();labels,image=data.rsplit(' ',1);assert json.loads(labels).get(LABEL)=='fixed-test'and image==IMAGE;call(['rm','--force',name])
if __name__=='__main__':
 result=[case(False),case(True)];print(json.dumps({'cases':result,'real_credentials_read':False,'production_mounts':False,'network':'none','containers_cleaned':True}))
