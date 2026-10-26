// Candidate internal worker. No production entrypoint or MCP registration.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {IDS,normalizedIdentity}=require('../attestation_model.cjs');
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const json=x=>JSON.stringify(stable(x));
const hash=x=>crypto.createHash('sha256').update(json(x)).digest('hex');
const need=(condition,reason)=>{if(!condition)throw new Error(reason);};
const isId=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
const isSha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function protectedDirectory(folder) {
 for(let current=path.resolve(folder);;current=path.dirname(current)) {
  need(!fs.lstatSync(current).isSymbolicLink(),'symlink_state_parent');if(path.dirname(current)===current)break;
 }
 const info=fs.lstatSync(folder);need(info.isDirectory()&&info.uid===process.getuid()&&(info.mode&0o777)===0o700,'unsafe_state_directory');
}
function syncDirectory(folder){const fd=fs.openSync(folder,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
class ReceiptStore {
 constructor(folder,purpose){need(['apply','rollback'].includes(purpose),'worker_purpose_required');protectedDirectory(folder);this.folder=path.resolve(folder);this.purpose=purpose;}
 location(op){need(isId(op),'operation_id_refused');return path.join(this.folder,op);}
 read(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const s=fs.fstatSync(fd);need(s.isFile()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size<=1048576,'unsafe_receipt');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
 }
 create(file,value){const body=Buffer.from(json(value)+'\n');need(body.length<=1048576,'receipt_size_limit');const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(file));}
 existing(binding){
  need(binding.action===this.purpose,'store_purpose_mismatch');const dir=this.location(binding.operation_id);if(!fs.existsSync(dir))return null;protectedDirectory(dir);
  const identity=this.read(path.join(dir,'identity.json'));need(identity.request_sha256===hash(binding),'operation_id_conflict');
  const receipt=path.join(dir,'receipt.json');
  if(fs.existsSync(receipt)){
   const value=this.read(receipt);need(Object.entries(binding).every(([key,item])=>value[key]===item),'receipt_identity_mismatch');
   need(['applied','rejected_without_effect','uncertain'].includes(value.state)&&typeof value.executor_terminal==='boolean'&&typeof value.session_revoked==='boolean'&&value.security_cleanup_confirmed===value.session_revoked&&value.receipt_verified===true,'receipt_shape_refused');
   if(value.state==='applied')need(value.loaded_sha256===binding.after_sha256&&value.executor_terminal===true,'receipt_loaded_identity_mismatch');
   return value;
  }
  return {state:'uncertain',operation_id:binding.operation_id,component_id:binding.component_id,task_id:binding.task_id,collection_error:'existing_intent_without_terminal_receipt',executor_terminal:false,receipt_verified:false,effect_repeated:false};
 }
 register(binding){
  const entries=fs.readdirSync(this.folder,{withFileTypes:true});need(entries.length<64,'operation_capacity');let bytes=0;
  for(const entry of entries){need(entry.isDirectory()&&isId(entry.name),'unexpected_state_entry');const dir=this.location(entry.name);protectedDirectory(dir);for(const name of fs.readdirSync(dir)){need(['identity.json','scope-before.json','intent.json','receipt.json'].includes(name),'unexpected_state_file');const s=fs.lstatSync(path.join(dir,name));need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o777)===0o600,'unsafe_state_file');bytes+=s.size;}}
  need(bytes+1048576+32768<=32*1048576,'state_storage_capacity');
  const dir=this.location(binding.operation_id);try{fs.mkdirSync(dir,{mode:0o700});}catch(error){if(error.code==='EEXIST'){this.existing(binding);return false;}throw error;}syncDirectory(this.folder);
  this.create(path.join(dir,'identity.json'),{...binding,request_sha256:hash(binding)});return true;
 }
 begin(binding,before){
  const dir=this.location(binding.operation_id);protectedDirectory(dir);const identity=this.read(path.join(dir,'identity.json'));need(identity.request_sha256===hash(binding),'operation_id_conflict');
  this.create(path.join(dir,'scope-before.json'),before);
  this.create(path.join(dir,'intent.json'),{operation_id:binding.operation_id,state:'intent_before_deploy',request_sha256:hash(binding),automatic_retry:false});
 }
 finish(binding,result){this.create(path.join(this.location(binding.operation_id),'receipt.json'),result);return this.existing(binding);}
}
class FixedNodeRedClient {
 constructor(binding){
  need(binding&&typeof binding.host==='string'&&binding.host.length<254&&Number.isInteger(binding.port)&&binding.port>0&&binding.port<65536,'operator_binding_refused');
  need(typeof binding.username==='string'&&typeof binding.password==='string','existing_authentication_unavailable');
  this.binding=binding;this.token=null;
 }
 #request(method,route,data){return new Promise((resolve,reject)=>{
  const body=data===undefined?null:JSON.stringify(data);const req=http.request({host:this.binding.host,port:this.binding.port,path:route,method,
   headers:{'Node-RED-API-Version':'v2','Node-RED-Deployment-Type':'nodes',...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{}),...(this.token?{Authorization:'Bearer '+this.token}:{})}},res=>{
    const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>16*1048576)req.destroy(new Error('bounded_response_limit'));else chunks.push(chunk);});
    res.on('end',()=>{try{const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,data:text?JSON.parse(text):null});}catch{reject(new Error('bounded_response_invalid'));}});
    res.on('error',()=>reject(new Error('transport_outcome_unknown')));
   });req.setTimeout(12000,()=>req.destroy(new Error('transport_outcome_unknown')));req.on('error',()=>reject(new Error('transport_outcome_unknown')));req.end(body);
 });}
 async login(){const r=await this.#request('POST','/auth/token',{client_id:'node-red-admin',grant_type:'password',scope:'*',username:this.binding.username,password:this.binding.password});need(r.status===200&&typeof r.data?.access_token==='string','authentication_refused');this.token=r.data.access_token;}
 async configuration(){const r=await this.#request('GET','/flows');need(r.status===200&&isSha(r.data?.rev)&&Array.isArray(r.data.flows)&&r.data.flows.length<=10000,'configuration_unconfirmed');return r.data;}
 async deploy(revision,flows){return this.#request('POST','/flows',{rev:revision,flows});}
 async revoke(){if(!this.token)return true;try{const r=await this.#request('POST','/auth/revoke',{token:this.token});return r.status>=200&&r.status<300;}catch{return false;}finally{this.token=null;}}
}
function selected(flows,component){const id=IDS[component];need(id,'unsupported_runtime');const nodes=flows.filter(n=>n.id===id||n.z===id);need(nodes.some(n=>n.id===id&&n.type==='tab')&&nodes.length<=2048,'scope_missing_or_oversized');return nodes;}
function nodeCanonical(value){const copy=structuredClone(value);copy.wires??=[];need(Array.isArray(copy.wires)&&copy.wires.every(Array.isArray),'wire_shape_refused');while(copy.wires.length&&copy.wires.at(-1).length===0)copy.wires.pop();return copy;}
function validateDelta(before,after){
 need(Array.isArray(after)&&after.length===before.length,'node_set_changed');const current=new Map(before.map(n=>[n.id,n]));const seen=new Set();let count=0;
 for(const proposed of after){need(proposed&&typeof proposed.id==='string'&&!seen.has(proposed.id)&&current.has(proposed.id),'node_identity_changed');seen.add(proposed.id);
  const old=current.get(proposed.id),a=nodeCanonical(old),b=nodeCanonical(proposed);const fields=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(key=>json(a[key])!==json(b[key]));if(!fields.length)continue;
  need(fields.length===1&&((old.type==='function'&&fields[0]==='func')||(old.type==='change'&&fields[0]==='rules')),'effect_boundary_or_configuration_change_refused');
  if(old.type==='function'){need(typeof proposed.func==='string'&&Buffer.byteLength(proposed.func)<=65536,'function_limit');need(!old.initialize&&!old.finalize,'startup_or_finalize_effect_unreviewed');}
  else need(Array.isArray(proposed.rules)&&Buffer.byteLength(json(proposed.rules))<=65536,'rules_limit');
  count++;
 }
 need(count>0&&count<=16,'empty_or_oversized_change');
}
function validatePrepared(p){
 const fields=['operation_id','task_id','principal_sha256','component_id','before_sha256','after_sha256','candidate_nodes'];
 need(p&&typeof p==='object'&&Object.keys(p).length===fields.length&&fields.every(k=>Object.hasOwn(p,k)),'prepared_record_refused');
 need(isId(p.operation_id)&&isId(p.task_id)&&isSha(p.principal_sha256)&&isSha(p.before_sha256)&&isSha(p.after_sha256)&&Object.hasOwn(IDS,p.component_id),'prepared_identity_refused');
 need(p.before_sha256!==p.after_sha256&&Array.isArray(p.candidate_nodes)&&Buffer.byteLength(json(p.candidate_nodes))<=1048576,'candidate_size_or_identity_refused');
 need(normalizedIdentity(p.candidate_nodes)===p.after_sha256,'candidate_digest_changed');
 return Object.fromEntries(fields.filter(k=>k!=='candidate_nodes').map(k=>[k,p[k]]));
}
class NodeRedWorker {
 constructor({client,store,admission,purpose,clock=()=>Date.now()/1000}){need(['apply','rollback'].includes(purpose)&&store.purpose===purpose,'worker_purpose_required');this.client=client;this.store=store;this.admission=admission;this.purpose=purpose;this.clock=clock;}
 async check(binding){
  need(typeof this.admission==='function','protected_admission_unavailable');const gate=await this.admission(binding);
  need(gate?.registered_task===true&&gate?.reviewed_candidate===true&&gate?.principal_matches===true&&gate?.shared_budget_reserved===true,'task_or_review_binding_unconfirmed');
  need(Object.entries(binding).every(([key,value])=>gate[key]===value)&&gate.identity_kind==='nodered_scoped_configuration_v1','admission_identity_mismatch');
  need(typeof gate.observed_at==='number'&&Number.isFinite(gate.observed_at)&&0<=this.clock()-gate.observed_at&&this.clock()-gate.observed_at<=5,'admission_observation_stale');
  need(gate.global_admin_idle===true&&gate.resources_available===true&&gate.maintenance_lock_held===true,'coordination_or_resources_unconfirmed');
  need(typeof gate.expires_at==='number'&&Number.isFinite(gate.expires_at)&&this.clock()+90<gate.expires_at,'administrative_lease_completion_margin');
 }
 async execute(prepared){
  const binding={...validatePrepared(prepared),action:this.purpose};const existing=this.store.existing(binding);if(existing)return {...existing,effect_repeated:false,duplicate:true};
  await this.check(binding);let registered=false,attempted=false,result=null,sessionRevoked=true;
  try{
   registered=this.store.register(binding);if(!registered)return {...this.store.existing(binding),effect_repeated:false,duplicate:true};
   await this.client.login();const before=await this.client.configuration();const oldScope=selected(before.flows,binding.component_id);
   need(normalizedIdentity(oldScope)===binding.before_sha256,'loaded_version_changed');validateDelta(oldScope,prepared.candidate_nodes);
   const replacements=new Map(prepared.candidate_nodes.map(n=>[n.id,n]));const proposal=before.flows.map(n=>replacements.get(n.id)??n);
   const expectedFull=hash(proposal);await this.check(binding);
   this.store.begin(binding,oldScope);attempted=true;
   const response=await this.client.deploy(before.rev,proposal);
   if(response.status===409)result={state:'rejected_without_effect',collection_error:'revision_conflict',executor_terminal:true,definitive_no_effect:true};
   else{
    need((response.status===200||response.status===204)&&isSha(response.data?.rev),'deploy_response_unconfirmed');
    const loaded=await this.client.configuration();need(loaded.rev===response.data.rev&&hash(loaded.flows)===expectedFull&&normalizedIdentity(selected(loaded.flows,binding.component_id))===binding.after_sha256,'loaded_verification_unconfirmed');
    result={state:'applied',loaded_sha256:binding.after_sha256,collection_error:null,executor_terminal:true,other_scope_preserved_by_submission:true};
   }
  }catch{
   result={state:attempted?'uncertain':'rejected_without_effect',collection_error:attempted?'effect_outcome_unconfirmed':'pre_effect_validation_or_collection_failed',executor_terminal:!attempted,definitive_no_effect:!attempted};
  }finally{try{sessionRevoked=await this.client.revoke();}catch{sessionRevoked=false;}}
  const safe={...result,...binding,effect_attempted:attempted,session_revoked:sessionRevoked,security_cleanup_confirmed:sessionRevoked,worker_finished_at:this.clock(),automatic_retry:false,receipt_verified:true};
  if(!registered)return {...safe,state:'uncertain',executor_terminal:false,receipt_verified:false,collection_error:'worker_registration_unconfirmed'};
  try{return this.store.finish(binding,safe);}catch{return {...safe,state:'uncertain',receipt_verified:false,executor_terminal:false,collection_error:'terminal_receipt_write_unconfirmed'};}
 }
}
module.exports={ReceiptStore,FixedNodeRedClient,NodeRedWorker,selected,validateDelta,validatePrepared};
