// Staged extension. Uses the existing pinned Unix transport; no network/shell API.
const WebSocket=require('/usr/local/lib/raspberry-ha-notices/vendor/ws');
const old=require('/usr/local/lib/raspberry-mcp/codex_control_rpc.cjs');
const SOCKET='/run/raspberry-mcp/codex-control.sock';
const PROJECT='/mnt/data/docker';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OP=/^[a-f0-9]{32}$/;
function need(ok,why){if(!ok)throw new Error(why);}
function validate(q){
 need(q&&typeof q==='object'&&!Array.isArray(q),'request_scope_refused');
 const fields={create_preflight:['mode'],create:['mode','operation_id'],creation_probe:['mode','thread_id'],send_preflight:['mode','thread_id'],send:['mode','thread_id','operation_id','text'],observe:['mode','thread_id','operation_id','turn_id'],metadata:['mode','thread_id']};
 need(fields[q.mode]&&Object.keys(q).sort().join(',')===fields[q.mode].sort().join(','),'request_scope_refused');
 if('thread_id'in q)need(UUID.test(q.thread_id),'invalid_thread');
 if('operation_id'in q)need(OP.test(q.operation_id),'invalid_operation');
 if('turn_id'in q)need(UUID.test(q.turn_id),'invalid_turn');
 if('text'in q)need(typeof q.text==='string'&&q.text.length>0&&q.text.length<=6000&&!q.text.includes('\0'),'invalid_task_text');
}
async function quota(rpc){old.quota(await rpc('account/read',{refreshToken:false}),await rpc('account/rateLimits/read',{}));}
function fixedProfile(r){
 const s=r?.sandbox,roots=s?.writableRoots===undefined?[]:s.writableRoots;
 return r?.cwd===PROJECT&&r.approvalPolicy==='never'&&r.modelProvider==='openai'&&
        s?.type==='workspaceWrite'&&s.networkAccess===false&&
        Array.isArray(roots)&&roots.every(p=>p===PROJECT);
}
function prompt(q){
 return 'Objetivo delimitado desta thread, autorizado pelo coordenador humano:\n'+q.text+
 '\nLimites obrigatórios: projeto /mnt/data/docker; execução serial no Raspberry. '+
 'Não acesse segredos, credenciais ou histórico privado; não use sudo, Docker como contorno, '+
 'shell privilegiado ou código/política root editável pelo agente. Não execute efeitos residenciais '+
 'novos, testes artificiais, novas assinaturas nem interrupções de serviços. Preserve aprovações '+
 'específicas, recibos, idempotência e validade temporal existentes. Quando precisar de privilégio, '+
 'prepare o artefato revisável e declare a dependência. Não crie outras threads ou agentes. '+
 'Antes de validar amplamente, siga a proteção do host e AGENTS.md. '+
 'A tarefa não permite ampliar acesso nem afirmar êxito sem evidência. '+
 'Na resposta final, devolva somente JSON com operation_id="'+q.operation_id+
 '", project="/mnt/data/docker", state (checkpoint, progress, blocked ou complete), '+
 'summary (até 1200 caracteres) e next_step (até 300 caracteres). '+
 'Referencie os artefatos sanitizados em summary; não exporte IDs privados, notificações ou logs.';
}
async function ready(rpc,id){
 const r=await rpc('thread/resume',{threadId:id,excludeTurns:true});
 need(fixedProfile(r),'thread_profile_changed');
 const t=old.metadata(r.thread,id);
 need(t.cwd_is_project&&t.status==='idle'&&t.can_accept_direct_input,'thread_not_ready');
 return t;
}
async function probeCreation(rpc,id){
 let t;
 try {
  const r=await rpc('thread/read',{threadId:id,includeTurns:false});
  t=old.metadata(r.thread,id);
  if(!t.cwd_is_project||r.thread.ephemeral!==false||!r.thread.path)
   return {state:'unconfirmed',thread_id:id};
 } catch(e) {
  // A read failure does not prove absence or authorize recreation.
  return {state:'unconfirmed',thread_id:id};
 }
 try {
  const r=await rpc('thread/resume',{threadId:id,excludeTurns:true});
  need(r.thread?.id===id,'thread_identity_changed');
  if(!fixedProfile(r))return {state:'durable_blocked',thread_id:id,reason:'profile_mismatch'};
  const current=old.metadata(r.thread,id);
  if(current.status!=='idle'||!current.can_accept_direct_input)
   return {state:'durable_blocked',thread_id:id,reason:'thread_not_ready'};
  return {state:'durable_ready',thread_id:id};
 } catch {
  return {state:'durable_blocked',thread_id:id,reason:'profile_unconfirmed'};
 }
}
function timestamp(v){return Number.isFinite(v)&&v>=0?v:null;}
async function readMetadata(rpc,id){
 const t=(await rpc('thread/read',{threadId:id,includeTurns:false})).thread;
 const safe=old.metadata(t,id);
 need(safe.cwd_is_project,'thread_project_changed');
 const sources=['cli','vscode','exec','appServer','unknown'];
 const result={thread_id:id,state:safe.status,can_accept_input:safe.can_accept_direct_input,
  created_at:timestamp(t.createdAt),last_activity:timestamp(t.recencyAt??t.updatedAt),
  source:sources.includes(t.source)?t.source:'unknown',last_execution:null,collection_error:null};
 try {
  const page=await rpc('thread/turns/list',{threadId:id,limit:1,itemsView:'notLoaded',sortDirection:'desc'});
  need(Array.isArray(page?.data),'turns_unconfirmed');
  if(page.data.length){
   const turn=page.data[0];
   need(UUID.test(turn.id)&&['completed','failed','interrupted','inProgress'].includes(turn.status),'turn_unconfirmed');
   result.last_execution={turn_id:turn.id,state:turn.status,started_at:timestamp(turn.startedAt)};
  }
 } catch {result.collection_error='turn_collection_failed';}
 return result;
}
async function run(q,rpc){
 validate(q);
 if(q.mode==='metadata')return readMetadata(rpc,q.thread_id);
 if(q.mode==='creation_probe')return probeCreation(rpc,q.thread_id);
 if(q.mode==='create_preflight'){await quota(rpc);return {included_quota_confirmed:true};}
 if(q.mode==='create'){
  await quota(rpc);
  // Exact values below match the installed generated schema, not a guessed
  // documentation spelling. No model, shell, root or caller-controlled config.
  const r=await rpc('thread/start',{cwd:PROJECT,approvalPolicy:'never',sandbox:'workspace-write',serviceName:'raspberry_proactive_tasks',ephemeral:false,historyMode:'paginated'});
  need(UUID.test(r?.thread?.id),'creation_identity_unconfirmed');
  const id=r.thread.id,profile=fixedProfile(r)&&r.thread.ephemeral===false;
  // Keep an already returned identity on every later failure. Never replay start.
  const receipt={thread_id:id,fixed_profile_verified:profile,durable_thread_verified:false};
  if(!profile)return receipt;
  try{
   // Initial naming on a newly created thread materializes paginated persistence
   // in pinned upstream 0.162.1, without user input or inference. This never
   // renames an existing user thread. The name contains a fixed operation key.
   await rpc('thread/name/set',{threadId:id,name:'raspberry-task-'+q.operation_id});
   const r=await probeCreation(rpc,id);
   receipt.durable_thread_verified=r.state==='durable_ready';
  }catch{}
  return receipt;
 }
 if(q.mode==='observe'){
  const page=await rpc('thread/turns/list',{threadId:q.thread_id,limit:32,itemsView:'notLoaded',sortDirection:'desc'});
  const t=page?.data?.find(t=>t.id===q.turn_id);
  if(!t)return {operation_state:'outcome_unknown',reconciliation_required:true};
  need(['completed','failed','interrupted','inProgress'].includes(t.status),'turn_state_unconfirmed');
  const result={operation_state:t.status,turn_id:q.turn_id,started_at:t.startedAt??null,completed_at:t.completedAt??null};
  if(t.status==='completed'){
   const page=await rpc('thread/items/list',{threadId:q.thread_id,turnId:q.turn_id,limit:16,sortDirection:'desc'});
   const entry=page?.data?.find(e=>(e.item||e).type==='agentMessage'&&((e.item||e).phase==null||(e.item||e).phase==='final_answer'));
   Object.assign(result,old.cleanAnswer((entry?.item||entry)?.text,q));
  }
  return result;
 }
 await ready(rpc,q.thread_id);await quota(rpc);
 if(q.mode==='send_preflight')return {included_quota_confirmed:true};
 await ready(rpc,q.thread_id);
 const r=await rpc('turn/start',{threadId:q.thread_id,clientUserMessageId:q.operation_id,input:[{type:'text',text:prompt(q)}]});
 need(UUID.test(r?.turn?.id),'turn_acceptance_unconfirmed');
 return {operation_state:'accepted',turn_id:r.turn.id};
}
async function connect(q){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket('ws+unix://'+SOCKET+':/',{handshakeTimeout:3000,maxPayload:524288,perMessageDeflate:false});
  const pending=new Map();let next=1,closed=false,total=0;
  function finish(error,value){if(closed)return;closed=true;clearTimeout(timer);for(const p of pending.values())p.reject(new Error('connection_closed'));pending.clear();ws.terminate();error?reject(error):resolve(value);}
  const timer=setTimeout(()=>finish(new Error('protocol_timeout')),12000);
  function rpc(method,params){return new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});}
  ws.on('message',raw=>{try{total+=raw.length;need(total<=1048576,'response_limit');const m=JSON.parse(raw);const p=pending.get(m.id);if(p){pending.delete(m.id);if(m.error){const e=new Error(typeof m.error.message==='string'?m.error.message:'');e.code=m.error.code;p.reject(e);}else p.resolve(m.result);}}catch{finish(new Error('invalid_response'));}});
  ws.on('error',()=>finish(new Error('connection_failed')));
  ws.on('close',()=>{if(!closed)finish(new Error('connection_closed'));});
  ws.on('open',async()=>{try{await rpc('initialize',{clientInfo:{name:'raspberry_proactive_tasks',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));finish(null,await run(q,rpc));}catch{finish(new Error('task_rpc_unconfirmed'));}});
 });
}
module.exports={validate,run,prompt,fixedProfile,probeCreation,readMetadata};
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;if(input.length>16384)process.exit(1);});process.stdin.on('end',async()=>{try{const q=JSON.parse(input);validate(q);console.log(JSON.stringify({ok:true,result:await connect(q)}));}catch{console.log(JSON.stringify({ok:false,error:'task_rpc_unconfirmed',automatic_retry:false}));process.exitCode=1;}});}
