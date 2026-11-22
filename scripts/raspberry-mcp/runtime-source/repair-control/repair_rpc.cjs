// Fixed RPC adapter. No shell, session database, auth file or arbitrary RPC input.
const fs=require('node:fs'),net=require('node:net'),WebSocket=require('/usr/local/lib/raspberry-ha-notices/vendor/ws');
const SOCKET='/run/raspberry-mcp/codex-control.sock';
const THREADS=['${AUTHORIZED_THREAD_ID_1}'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATES=new Set(['notLoaded','idle','active','systemError']);
class Refused extends Error{}
function requireOk(ok,why){if(!ok)throw new Refused(why);}
function validate(q){requireOk(q&&typeof q==='object'&&!Array.isArray(q)&&Object.keys(q).every(k=>['mode','thread_id','operation_id','intent','turn_id'].includes(k)),'invalid_internal_request');requireOk(THREADS.includes(q.thread_id)&&['metadata','preflight','send','observe'].includes(q.mode),'thread_out_of_scope');if(q.mode==='send'||q.mode==='observe')requireOk(/^[a-f0-9]{32}$/.test(q.operation_id),'invalid_operation_id');if(q.mode==='send')requireOk(['repair_health_summary'].includes(q.intent),'intent_out_of_scope');if(q.turn_id!==undefined&&q.turn_id!==null)requireOk(UUID.test(q.turn_id),'invalid_turn_id');}
const CHECKS=['old_failure_later_publication','later_failure','missing_times','conflicting_times','collection_failure','static_vs_current_events','dedupe','uncertain_no_replay'];
function prompt(q){
 requireOk(q.intent==='repair_health_summary','fixed_task_required');
 return 'Tarefa fixa repair_health_summary. Use apenas a correção selada e aprovada dos produtores backup_results e maintenance_capabilities. Execute exatamente `/usr/bin/python3 -I -S -B /usr/local/lib/raspberry-repair-control/verify_candidate.py` como usuário normal e relate seus resultados. O arquivo Python é root-owned e não é executável diretamente; não altere suas permissões. Não edite produção nem políticas, não use sudo ou Docker, não reinicie serviços, não leia credenciais, títulos/corpos de avisos ou logs privados e não envie notificações/comandos residenciais. Não crie threads nem delegue. Se o verificador ou os arquivos root não estiverem disponíveis, reporte blocked; não procure um contorno. Não troque modelo, autenticação ou permissões da thread. Não declare conclusão do objetivo doméstico integral. Responda somente JSON com operation_id="'+q.operation_id+'", project="/mnt/data/docker", task="repair_health_summary", state (complete, blocked ou failed), production_changes=false e checks contendo exatamente '+CHECKS.join(',')+', com valores passed, failed ou not_run. Nenhum texto livre ou outros campos.';
}
function cleanAnswer(text,q){
 if(typeof text!=='string'||Buffer.byteLength(text)>4096)return {answer_withheld:true};
 let v;try{v=JSON.parse(text);}catch{return {answer_withheld:true};}
 if(!v||Array.isArray(v)||Object.keys(v).sort().join(',')!=='checks,operation_id,production_changes,project,state,task'||v.operation_id!==q.operation_id||v.project!=='/mnt/data/docker'||v.task!=='repair_health_summary'||!['complete','blocked','failed'].includes(v.state)||v.production_changes!==false||!v.checks||Array.isArray(v.checks)||Object.keys(v.checks).sort().join(',')!==[...CHECKS].sort().join(',')||Object.values(v.checks).some(x=>!['passed','failed','not_run'].includes(x)))return {answer_withheld:true};
 if(v.state==='complete'&&Object.values(v.checks).some(x=>x!=='passed'))return {answer_withheld:true};
 return {answer:v,answer_withheld:false};
}
function quota(account,usage){
 requireOk(account?.account?.type==='chatgpt'&&['plus','pro','prolite','promax'].includes(account.account.planType),'personal_subscription_required');
 requireOk(usage?.ordinaryUsageAllowed===true,'included_quota_unconfirmed');
 const buckets=[usage.rateLimits,...Object.values(usage.rateLimitsByLimitId||{})];
 for(const b of buckets)requireOk(b&&b.credits?.hasCredits===false&&b.credits?.unlimited===false&&[null,undefined,'0','0.0','0.00'].includes(b.credits?.balance)&&b.rateLimitReachedType==null&&b.spendControlReached!==true,'extra_credit_or_quota_refused');
}
function metadata(t,id){requireOk(t?.id===id&&STATES.has(t.status?.type),'thread_metadata_unconfirmed');return {thread_id:id,status:t.status.type,ephemeral:t.ephemeral===true,cwd_is_project:t.cwd==='/mnt/data/docker',cwd:'/home/<HOST_OPERATOR>'===t.cwd?'/home/<HOST_OPERATOR>':t.cwd==='/mnt/data/docker'?'/mnt/data/docker':'other',can_accept_direct_input:t.canAcceptDirectInput===true,model_provider:t.modelProvider==='openai'?'openai':'unconfirmed',approval_needed:t.status.type==='active'&&t.status.activeFlags?.includes('waitingOnApproval')===true,user_input_needed:t.status.type==='active'&&t.status.activeFlags?.includes('waitingOnUserInput')===true};}
function enrolledProfile(p){
 requireOk(p&&typeof p==='object'&&Object.keys(p).sort().join(',')==='approvalPolicy,approvalsReviewer,cwd,model,modelProvider,reasoningEffort,sandbox,threadId','repair_resume_profile_shape');
 requireOk(p.threadId===THREADS[0]&&p.cwd==='/mnt/data/docker'&&p.model==='gpt-6.1-sol'&&p.modelProvider==='openai'&&p.approvalPolicy==='on-request'&&p.approvalsReviewer==='user'&&p.sandbox==='danger-full-access'&&p.reasoningEffort==='high','repair_resume_profile_scope');
 return p;
}
function checkProfile(r,p){
 requireOk(r&&r.thread?.id===p.threadId&&r.thread?.ephemeral!==true&&r.cwd===p.cwd&&r.thread.cwd===p.cwd&&r.model===p.model&&r.modelProvider===p.modelProvider&&r.thread.modelProvider===p.modelProvider&&r.approvalPolicy===p.approvalPolicy&&r.approvalsReviewer===p.approvalsReviewer&&r.sandbox?.type==='dangerFullAccess','repair_resume_effective_profile_mismatch');
 // Optional response fields are not identity/permission attestations.
 requireOk(r.reasoningEffort==null||r.reasoningEffort===p.reasoningEffort,'repair_resume_reported_effort_mismatch');
 requireOk(r.runtimeWorkspaceRoots===undefined||(Array.isArray(r.runtimeWorkspaceRoots)&&r.runtimeWorkspaceRoots.every(x=>x===p.cwd)),'repair_resume_reported_roots_mismatch');
 requireOk(!r.thread.turns||r.thread.turns.length===0,'repair_resume_history_unrequested');
 return {thread_id:p.threadId,cwd:r.cwd,model:r.model,model_provider:r.modelProvider,approval_policy:r.approvalPolicy,approvals_reviewer:r.approvalsReviewer,reasoning_effort:r.reasoningEffort??null,reasoning_effort_observation:r.reasoningEffort==null?'unreported':'reported',sandbox_type:r.sandbox.type,network_is_sandbox_restricted:false,runtime_workspace_roots:r.runtimeWorkspaceRoots??null,runtime_workspace_roots_observation:r.runtimeWorkspaceRoots===undefined?'unreported':'reported',profile_readback_verified:true};
}
async function resumeProfile(q,rpc,p,t){
 enrolledProfile(p);requireOk(q.mode==='preflight'&&/^[a-f0-9]{32}$/.test(q.operation_id),'repair_resume_operation_required');
 requireOk(t.status==='notLoaded'||(t.status==='idle'&&t.can_accept_direct_input),'repair_resume_thread_busy');
 requireOk(t.model_provider==='openai','repair_resume_provider_unconfirmed');
 const reply=await rpc('thread/resume',{threadId:p.threadId,excludeTurns:true,cwd:p.cwd,model:p.model,modelProvider:p.modelProvider,approvalPolicy:p.approvalPolicy,approvalsReviewer:p.approvalsReviewer,sandbox:p.sandbox,runtimeWorkspaceRoots:[p.cwd],config:{model_reasoning_effort:p.reasoningEffort}});
 const observed=checkProfile(reply,p);
 const readback=metadata((await rpc('thread/read',{threadId:p.threadId,includeTurns:false})).thread,p.threadId);
 requireOk(readback.status==='idle'&&readback.can_accept_direct_input&&readback.cwd_is_project&&readback.model_provider==='openai','repair_resume_readback_unconfirmed');
 return observed;
}
async function run(q,rpc,profile=null){
 validate(q);let t=metadata((await rpc('thread/read',{threadId:q.thread_id,includeTurns:false})).thread,q.thread_id);
 if(q.mode==='metadata')return t;
 let resumed=null;
 if(profile&&q.mode==='preflight'){quota(await rpc('account/read',{refreshToken:false}),await rpc('account/rateLimits/read',{}));resumed=await resumeProfile(q,rpc,profile,t);t=metadata((await rpc('thread/read',{threadId:q.thread_id,includeTurns:false})).thread,q.thread_id);}
 if(q.mode==='observe'){
  requireOk(q.turn_id&&UUID.test(q.turn_id),'outcome_unknown_reconciliation_required');
  const page=await rpc('thread/turns/list',{threadId:q.thread_id,limit:32,itemsView:'notLoaded',sortDirection:'desc'});
  const turn=page?.data?.find(x=>x.id===q.turn_id);
  if(!turn)return {...t,operation_state:'outcome_unknown',reconciliation_required:true};
  requireOk(['completed','interrupted','failed','inProgress'].includes(turn.status),'turn_state_unconfirmed');
  const result={...t,turn_id:q.turn_id,operation_state:turn.status,started_at:turn.startedAt??null,completed_at:turn.completedAt??null};
  if(turn.status==='completed'){
   const items=await rpc('thread/items/list',{threadId:q.thread_id,turnId:q.turn_id,limit:16,sortDirection:'desc'});
   const entry=items?.data?.find(e=>(e.item||e).type==='agentMessage'&&((e.item||e).phase==null||(e.item||e).phase==='final_answer'));
   Object.assign(result,cleanAnswer((entry?.item||entry)?.text,q));
  }
  return result;
 }
 // Historical profile metadata is not a standing resume grant. Loading a
 // legacy thread requires its own reviewed enrollment; never apply defaults.
 requireOk(t.status!=='notLoaded','legacy_resume_profile_unenrolled');
 requireOk(t.cwd_is_project&&t.model_provider==='openai','repair_thread_profile_unconfirmed');
 requireOk(t.status==='idle'&&t.can_accept_direct_input,'busy');
 quota(await rpc('account/read',{refreshToken:false}),await rpc('account/rateLimits/read',{}));
 if(q.mode==='preflight')return {...t,included_quota_confirmed:true,...(resumed?{resume_profile:resumed,profile_readback_verified:true}:{})};
 // Fresh status before sending. Other clients can race; do not claim a global CAS.
 const fresh=metadata((await rpc('thread/read',{threadId:q.thread_id,includeTurns:false})).thread,q.thread_id);
 requireOk(fresh.status==='idle'&&fresh.can_accept_direct_input,'busy');
 requireOk(fresh.cwd_is_project&&fresh.model_provider==='openai','repair_thread_profile_unconfirmed');
 const reply=await rpc('turn/start',{threadId:q.thread_id,clientUserMessageId:q.operation_id,input:[{type:'text',text:prompt(q)}]});
 requireOk(UUID.test(reply?.turn?.id),'turn_acceptance_unconfirmed');
 return {thread_id:q.thread_id,operation_state:'accepted',turn_id:reply.turn.id,model_started_or_input_accepted:true};
}
async function connect(q){
 return new Promise((resolve,reject)=>{
  const options={handshakeTimeout:3000,maxPayload:524288,perMessageDeflate:false};
  const passedFd=process.env.TASK_PEER_FD;
  if(passedFd!==undefined){
   requireOk(/^[0-9]+$/.test(passedFd),'invalid_peer_fd');
   const fd=Number(passedFd);requireOk(Number.isSafeInteger(fd)&&fd>=3&&fs.fstatSync(fd).isSocket(),'invalid_peer_fd');
   let used=false;options.createConnection=()=>{requireOk(!used,'peer_fd_reused');used=true;return new net.Socket({fd,readable:true,writable:true});};
  }
  const ws=new WebSocket('ws+unix://'+SOCKET+':/',options);
  const pending=new Map();let next=1,closed=false,total=0;
  function finish(error,value){if(closed)return;closed=true;clearTimeout(timer);for(const p of pending.values())p.reject(new Refused('connection_closed'));pending.clear();ws.terminate();error?reject(error):resolve(value);}
  const timer=setTimeout(()=>finish(new Refused('protocol_timeout')),12000);
  function rpc(method,params){return new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});}
  ws.on('message',raw=>{try{total+=raw.length;requireOk(total<=1048576,'response_limit');const m=JSON.parse(raw);if(m.method)return;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Refused('rpc_refused')):p.resolve(m.result);}}catch{finish(new Refused('invalid_response'));}});
  ws.on('error',()=>finish(new Refused('connection_failed')));
  ws.on('close',()=>{if(!closed)finish(new Refused('connection_closed'));});
  ws.on('open',async()=>{try{await rpc('initialize',{clientInfo:{name:'raspberry_fixed_repair_control',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));finish(null,await run(q,rpc,process.env.REPAIR_RESUME_PROFILE_JSON?JSON.parse(process.env.REPAIR_RESUME_PROFILE_JSON):null));}catch(e){finish(e instanceof Refused?e:new Refused('rpc_unconfirmed'));}});
 });
}
module.exports={THREADS,CHECKS,validate,prompt,quota,metadata,cleanAnswer,run,Refused,enrolledProfile,checkProfile,resumeProfile};
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;if(input.length>4096)process.exit(1);});process.stdin.on('end',async()=>{try{const q=JSON.parse(input);validate(q);console.log(JSON.stringify({ok:true,result:await connect(q)}));}catch(e){console.log(JSON.stringify({ok:false,error:e instanceof Refused?e.message:'adapter_unconfirmed',automatic_retry:false}));process.exitCode=1;}});}
