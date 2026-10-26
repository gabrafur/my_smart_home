"""Candidate static code identity; compiles bytes, NEVER executes proposed code.
Trusted root bootstrap supplies the pinned native fingerprint port. Not an MCP
callback, validation approval, sandbox, loaded-runtime or functional proof.
"""
import ast,hashlib,json,re,sys,types
MODULES=frozenset(('heartbeat','history','webhook','loaded_identity'))
def need(v,r):
 if not v:raise ValueError(r)
def code_named(parent,name):
 found=[v for v in parent.co_consts if isinstance(v,types.CodeType)and v.co_name==name]
 need(len(found)==1,'declared_code_inventory_ambiguous');return found[0]
def plain_decorators(node,method=False):
 allowed={'classmethod','staticmethod'}if method else set()
 need(all(isinstance(d,ast.Name)and d.id in allowed for d in node.decorator_list),'dynamic_decorator_inventory_unconfirmed')
def inventory(label,source):
 need(isinstance(source,bytes)and 0<len(source)<=65536,'source_size_or_type_refused');tree=ast.parse(source.decode('utf8'));code=compile(tree,'<reviewed-proposal>','exec',dont_inherit=True,optimize=0);out={};declared=set()
 for node in tree.body:
  if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
   need(node.name not in declared,'duplicate_declared_binding');declared.add(node.name)
   if isinstance(node,ast.ClassDef):
    need(not node.decorator_list,'dynamic_class_inventory_unconfirmed');parent=code_named(code,node.name);methods=set()
    for method in node.body:
     if isinstance(method,(ast.FunctionDef,ast.AsyncFunctionDef)):
      need(method.name not in methods,'duplicate_method_binding');methods.add(method.name);plain_decorators(method,True);out[label+'.'+node.name+'.'+method.name]=code_named(parent,method.name)
     elif isinstance(method,ast.ClassDef):raise ValueError('nested_class_inventory_unconfirmed')
   else:plain_decorators(node);out[label+'.'+node.name]=code_named(code,node.name)
  elif any(isinstance(v,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef))for v in ast.walk(node)):
   raise ValueError('conditional_declaration_inventory_unconfirmed')
 return out
class SourceCodeIdentity:
 def __init__(self,pinned_native_fingerprint):self.fingerprint=pinned_native_fingerprint
 def compile(self,sources):
  need(isinstance(sources,dict)and set(sources)==MODULES,'fixed_module_scope_required');functions={}
  for label,raw in sorted(sources.items()):functions.update(inventory(label,raw))
  need(bool(functions),'empty_declared_code_inventory');digest=self.fingerprint({name:types.SimpleNamespace(__code__=code)for name,code in functions.items()});need(isinstance(digest,str)and re.fullmatch('[a-f0-9]{64}',digest),'fingerprint_port_invalid')
  identities=sorted((label,hashlib.sha256(raw).hexdigest())for label,raw in sources.items());source_hash=hashlib.sha256(json.dumps(identities,separators=(',',':')).encode()).hexdigest()
  return {'source':'compiled_declared_component_code','component_id':'external_heartbeat','state':'compiled','identity_kind':'python_code_objects_v1','expected_code_sha256':digest,'runtime_cache_tag':sys.implementation.cache_tag,'declared_function_count':len(functions),'source_set_sha256':source_hash,'proposal_code_executed':False,'coverage':['declared_functions_and_methods_only','same_native_code_fingerprint_domain','not_module_data_or_runtime_import_bindings','not_security_review_sandbox_or_approval','not_loaded_runtime_or_functional_health']}
