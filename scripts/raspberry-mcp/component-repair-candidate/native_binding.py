"""Pure systemd binding model. Collector supplies only fixed unit metadata."""
import hashlib,math,re

def verified(proof,manager,boot_id):
 if not isinstance(proof,dict)or not isinstance(manager,dict)or not isinstance(boot_id,str):return False
 try:
  invocation=manager['InvocationID'];pid=manager['ExecMainPID'];start=manager['ExecMainStartTimestampMonotonic'];end=manager['ExecMainExitTimestampMonotonic'];observed=proof['observed_monotonic']
  if re.fullmatch('[a-f0-9]{32}',invocation)is None or re.fullmatch('[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',boot_id)is None:return False
  if any(type(x)is not int for x in(pid,start,end))or type(observed)not in(int,float)or not math.isfinite(observed):return False
  return (0<pid<2**22 and pid==proof.get('pid')and 0<start<=observed*1000000<=end
   and manager.get('ActiveState')in('inactive','failed')and manager.get('SubState')in('dead','failed')and manager.get('Result')in('success','exit-code')
   and hashlib.sha256(invocation.encode()).hexdigest()==proof.get('invocation_id_sha256')and hashlib.sha256(boot_id.encode()).hexdigest()==proof.get('boot_id_sha256'))
 except (KeyError,TypeError,ValueError):return False
