"""Code identity emitted by the existing native heartbeat, without credentials.
Fingerprint domain matches python_code_objects_v1; hashes static component code,
never stack/local variables, request identifiers, private messages or responses.
"""
import datetime,hashlib,json,os,re,sys,time,types

def _constant(value):
 if isinstance(value,types.CodeType):return ['code',_normalize(value)]
 if isinstance(value,bytes):return ['bytes',value.hex()]
 if isinstance(value,tuple):return ['tuple',[_constant(x)for x in value]]
 if isinstance(value,frozenset):return ['frozenset',sorted((_constant(x)for x in value),key=lambda x:json.dumps(x,sort_keys=True))]
 if value is Ellipsis:return ['ellipsis']
 if isinstance(value,complex):return ['complex',repr(value)]
 return [type(value).__name__,value]
def _normalize(code):
 return {'bytecode':code.co_code.hex(),'constants':[_constant(x)for x in code.co_consts],'names':code.co_names,'varnames':code.co_varnames,'freevars':code.co_freevars,'cellvars':code.co_cellvars,'args':code.co_argcount,'posonly':code.co_posonlyargcount,'kwonly':code.co_kwonlyargcount,'flags':code.co_flags,'exception_table':code.co_exceptiontable.hex()}
def fingerprint(functions):
 rows=[(name,hashlib.sha256(json.dumps(_normalize(fn.__code__),sort_keys=True,separators=(',',':')).encode()).hexdigest())for name,fn in sorted(functions.items())]
 return hashlib.sha256(json.dumps([sys.implementation.cache_tag,rows],separators=(',',':')).encode()).hexdigest()
def _functions(label,module):
 result={}
 for name,value in vars(module).items():
  if isinstance(value,types.FunctionType)and value.__module__==module.__name__:result[label+'.'+name]=value
  elif isinstance(value,type)and value.__module__==module.__name__:
   for key,fn in vars(value).items():
    if isinstance(fn,(classmethod,staticmethod)):fn=fn.__func__
    if isinstance(fn,types.FunctionType):result[label+'.'+name+'.'+key]=fn
 return result

def code_identity(heartbeat):
 history=sys.modules[heartbeat.History.__module__];webhook=sys.modules[heartbeat.post.__module__]
 modules={'heartbeat':heartbeat,'history':history,'webhook':webhook,'loaded_identity':sys.modules[__name__]};functions={}
 for name,module in modules.items():functions.update(_functions(name,module))
 critical={'heartbeat_history':heartbeat.HISTORY,'heartbeat_credential_path':heartbeat.CREDENTIAL,'history_limit':history.LIMIT,'history_retention':history.RETENTION,'webhook_max_body':webhook.MAX_BODY,'webhook_max_reply':webhook.MAX_REPLY}
 valid=(heartbeat.History is history.History and heartbeat.post is webhook.post and heartbeat.send_once.__defaults__==(webhook.post,time.time)and history.History.__init__.__defaults__==(time.time,)and webhook.resolve_public.__defaults__==(webhook.socket.getaddrinfo,)and heartbeat.capture_loaded_identity is capture)
 return {'loaded_code_sha256':fingerprint(functions),'critical_binding_sha256':hashlib.sha256(json.dumps(critical,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'critical_bindings_valid':valid,'runtime_cache_tag':sys.implementation.cache_tag}

def _kernel_identity():
 def read(path,maximum):
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   data=os.read(fd,maximum+1)
   if len(data)>maximum:raise ValueError('kernel_identity_limit')
   return data.decode('ascii').strip()
  finally:os.close(fd)
 invocation=os.environ.get('INVOCATION_ID','');boot=read('/proc/sys/kernel/random/boot_id',64)
 if re.fullmatch('[a-f0-9]{32}',invocation)is None or re.fullmatch('[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',boot)is None:raise ValueError('native_invocation_identity_unavailable')
 ticks=read('/proc/self/stat',4096).rsplit(')',1)[1].split()[19]
 if re.fullmatch('[0-9]{1,20}',ticks)is None:raise ValueError('native_process_identity_unavailable')
 return {'pid':os.getpid(),'process_start_ticks':ticks,'boot_id_sha256':hashlib.sha256(boot.encode()).hexdigest(),'invocation_id_sha256':hashlib.sha256(invocation.encode()).hexdigest()}
def capture(heartbeat):
 identity=code_identity(heartbeat);kernel=_kernel_identity()
 return {'schema_version':1,'source':'native_heartbeat.loaded_code','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'observed_monotonic':time.monotonic(),'identity_kind':'python_code_objects_v1',**identity,**kernel}
