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
 const fields={metadata_batch:['mode','thread_ids'],create_preflight:['mode'],create:['mode','operation_id'],creation_probe:['mode','thread_id'],send_preflight:['mode','thread_id'],send:['mode','thread_id','operation_id','text'],observe:['mode','thread_id','operation_id','turn_id']};
 need(fields[q.mode]&&Object.keys(q).filter(k=>k!=='profile').sort().join(',')===fields[q.mode].sort().join(','),'request_scope_refused');
 if('profile'in q)need(q.profile==='eva_admin'&&['create_preflight','create','creation_probe','send_preflight','send'].includes(q.mode),'admin_profile_refused');
 if('thread_id'in q)need(UUID.test(q.thread_id),'invalid_thread');
 if('operation_id'in q)need(OP.test(q.operation_id),'invalid_operation');
 if('turn_id'in q)need(UUID.test(q.turn_id),'invalid_turn');
 if('text'in q)need(typeof q.text==='string'&&q.text.length>0&&q.text.length<=6000&&!q.text.includes('\0'),'invalid_task_text');
 if('thread_ids'in q)need(Array.isArray(q.thread_ids)&&q.thread_ids.length<=24&&new Set(q.thread_ids).size===q.thread_ids.length&&q.thread_ids.every(x=>typeof x==='string'&&UUID.test(x)),'invalid_metadata_scope');
}
async function quota(rpc){old.quota(await rpc('account/read',{refreshToken:false}),await rpc('account/rateLimits/read',{}));}
function fixedProfile(r){
 const s=r?.sandbox,roots=s?.writableRoots===undefined?[]:s.writableRoots;
 return r?.cwd===PROJECT&&r.approvalPolicy==='never'&&r.modelProvider==='openai'&&
        s?.type==='workspaceWrite'&&s.networkAccess===false&&
        Array.isArray(roots)&&roots.every(p=>p===PROJECT);
}
function adminProfile(r){
 return r?.cwd===PROJECT&&r.approvalPolicy==='never'&&r.modelProvider==='openai'&&
        r?.sandbox?.type==='dangerFullAccess';
}
function profileParams(admin){return admin
 ? {cwd:PROJECT,approvalPolicy:'never',sandbox:'danger-full-access'}
 : {cwd:PROJECT,approvalPolicy:'never',permissions:':workspace',runtimeWorkspaceRoots:[PROJECT],config:{'sandbox_workspace_write.network_access':false}};}
function adminPrompt(q){
 return 'Tarefa administrativa delegada expressamente pelo proprietário à Eva/dots. Objetivo:\n'+q.text+
 '\nAutoridade: mesma delegação administrativa da conversa principal para a meta doméstica em /mnt/data/docker e plano /home/gabriel/smart-home-proactive-review-20261023. '+
 'Leia AGENTS.md, checkpoint.json, NEXT-CONVERSATION.json e GOAL-ADDENDUM-EVA-20261024.txt. A autorização não exige novas aprovações por ação dentro da meta. '+
 'Identidade nativa gabriel UID1001. Quando necessário e dentro da validade, use somente a conta dedicada codex-house-01a16f9f pela rota sudo -n -u codex-house-01a16f9f /usr/bin/sudo -n, sem senha. '+
 'Código e políticas privilegiados devem pertencer a root. Validade administrativa termina em 2026-10-25T15:25:22.'+'244394Z: não prorrogue, não mantenha acesso administrativo residual e não comece trabalho privilegiado que ultrapasse o prazo. '+
 'Preserve execução serial, limites compartilhados, custo adicional zero e quota incluída. Não exporte nem capture credenciais, mensagens privadas, histórico bruto ou logs privados. '+
 'Não use Docker como contorno, não gere eventos artificiais, não amplie efeitos residenciais ou reabra iluminação. Não repita operações incertas nem troque IDs/intents; reconcilie os recibos. '+
 'Não instale mecanismos de shell livre ou sudo geral no MCP. Não crie threads/agentes adicionais. Faça correção revisável, valide resultado real, registre evidência sanitizada no checkpoint central e preserve trabalhos concorrentes. '+
 'Na resposta final, devolva somente JSON com operation_id="'+q.operation_id+'", project="/mnt/data/docker", state (checkpoint, progress, blocked ou complete), summary (até1200 caracteres) e next_step (até300 caracteres). Não inclua dados privados.';
}
function prompt(q){
 if(q.profile==='eva_admin')return adminPrompt(q);
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
async function ready(rpc,id,admin=false){
 const before=old.metadata((await rpc('thread/read',{threadId:id,includeTurns:false})).thread,id);
 need(['idle','notLoaded'].includes(before.status),'thread_not_ready');
 // Restore only the original restricted adapter profile. A plain resume uses
 // daemon defaults, which can differ from the profile approved at creation.
 const r=await rpc('thread/resume',{threadId:id,excludeTurns:true,...profileParams(admin)});
 need(admin?adminProfile(r):fixedProfile(r),'thread_profile_changed');
 const t=old.metadata(r.thread,id);
 need(t.cwd_is_project&&t.status==='idle'&&t.can_accept_direct_input,'thread_not_ready');
 return t;
}
function exactMissing(error,method,id){
 return error?.code===-32600&&error?.message===(method==='thread/read'?'thread not loaded: '+id:'no rollout found for thread id '+id);
}
async function probeCreation(rpc,id,admin=false){
 let readMissing=false;
 try{
  const r=await rpc('thread/read',{threadId:id,includeTurns:false});
  const t=old.metadata(r.thread,id);
  if(t.cwd_is_project&&r.thread.ephemeral===false&&typeof r.thread.path==='string'&&r.thread.path.length>0){
   try{await ready(rpc,id,admin);return {state:'durable_ready',thread_id:id};}
   catch(e){return {state:'present_not_ready',thread_id:id,
    reason:['thread_not_ready','thread_profile_changed'].includes(e?.message)?e.message:'resume_unconfirmed'};}
  }
  return {state:'unconfirmed',thread_id:id};
 }catch(e){readMissing=exactMissing(e,'thread/read',id);}
 if(!readMissing)return {state:'unconfirmed',thread_id:id};
 try{await rpc('thread/resume',{threadId:id,excludeTurns:true});}
 catch(e){if(exactMissing(e,'thread/resume',id))return {state:'missing_before_first_send',thread_id:id,read_code:-32600,resume_code:-32600};}
 return {state:'unconfirmed',thread_id:id};
}
async function run(q,rpc){
 validate(q);
 if(q.mode==='metadata_batch'){
  const rows=[];
  for(const id of q.thread_ids){try{
   const r=await rpc('thread/read',{threadId:id,includeTurns:false}),t=old.metadata(r.thread,id);
   const validTime=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=Date.now()/1000+5?x:null;
   rows.push({...t,created_at:validTime(r.thread.createdAt),updated_at:validTime(r.thread.updatedAt),
    durable:r.thread.ephemeral===false&&typeof r.thread.path==='string'&&r.thread.path.length>0,
    collection_error:null});
  }catch(e){const unloaded=exactMissing(e,'thread/read',id);rows.push({thread_id:id,
   status:unloaded?'notLoaded':'unknown',can_accept_direct_input:false,
   collection_error:unloaded?'thread_not_loaded_metadata_unavailable':'daemon_metadata_unconfirmed'});}}
  return {rows};
 }
 if(q.mode==='creation_probe')return probeCreation(rpc,q.thread_id,q.profile==='eva_admin');
 if(q.mode==='create_preflight'){await quota(rpc);return {included_quota_confirmed:true};}
 if(q.mode==='create'){
  await quota(rpc);
  // Exact values below match the installed generated schema, not a guessed
  // documentation spelling. No model, shell, root or caller-controlled config.
  const r=await rpc('thread/start',{...profileParams(q.profile==='eva_admin'),
   serviceName:'raspberry_proactive_tasks',ephemeral:false,historyMode:'paginated'});
  need(UUID.test(r?.thread?.id),'creation_identity_unconfirmed');
  const id=r.thread.id,profile=(q.profile==='eva_admin'?adminProfile(r):fixedProfile(r))&&r.thread.ephemeral===false;
  // Keep an already returned identity on every later failure. Never replay start.
  const receipt={thread_id:id,fixed_profile_verified:profile,durable_thread_verified:false};
  if(!profile)return receipt;
  try{
   // Initial naming on a newly created thread materializes paginated persistence
   // in pinned upstream 0.162.1, without user input or inference. This never
   // renames an existing user thread. The name contains a fixed operation key.
   await rpc('thread/name/set',{threadId:id,name:'raspberry-task-'+q.operation_id});
   const r=await probeCreation(rpc,id,q.profile==='eva_admin');
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
 await ready(rpc,q.thread_id,q.profile==='eva_admin');await quota(rpc);
 if(q.mode==='send_preflight')return {included_quota_confirmed:true};
 await ready(rpc,q.thread_id,q.profile==='eva_admin');
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
  ws.on('open',async()=>{try{await rpc('initialize',{clientInfo:{name:'raspberry_proactive_tasks',version:'0.2.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));finish(null,await run(q,rpc));}catch(e){finish(new Error(['thread_not_ready','thread_profile_changed','invalid_metadata_scope'].includes(e?.message)?e.message:'task_rpc_unconfirmed'));}});
 });
}
module.exports={validate,run,prompt,fixedProfile,adminProfile,profileParams};
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;if(input.length>16384)process.exit(1);});process.stdin.on('end',async()=>{try{const q=JSON.parse(input);validate(q);console.log(JSON.stringify({ok:true,result:await connect(q)}));}catch(e){console.log(JSON.stringify({ok:false,error:['thread_not_ready','thread_profile_changed','invalid_metadata_scope'].includes(e?.message)?e.message:'task_rpc_unconfirmed',automatic_retry:false}));process.exitCode=1;}});}
