// Fixed RPC adapter. No shell, session database, auth file or arbitrary RPC input.
const fs=require('node:fs'),WebSocket=require('/usr/local/lib/raspberry-ha-notices/vendor/ws');
const SOCKET='/run/raspberry-mcp/codex-control.sock';
const THREADS=['${AUTHORIZED_THREAD_ID_1}','${AUTHORIZED_THREAD_ID_2}'];
const OBSERVATION_THREADS=[...THREADS,'${AUTHORIZED_THREAD_ID_3}'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATES=new Set(['notLoaded','idle','active','systemError']);
class Refused extends Error{}
function requireOk(ok,why){if(!ok)throw new Refused(why);}
function validate(q){requireOk(q&&typeof q==='object'&&!Array.isArray(q)&&Object.keys(q).every(k=>['mode','thread_id','operation_id','intent','turn_id'].includes(k)),'invalid_internal_request');requireOk((q.mode==='metadata'?OBSERVATION_THREADS:THREADS).includes(q.thread_id)&&['metadata','preflight','send','observe'].includes(q.mode),'thread_out_of_scope');if(q.mode==='send'||q.mode==='observe')requireOk(/^[a-f0-9]{32}$/.test(q.operation_id),'invalid_operation_id');if(q.mode==='send')requireOk(['continue','checkpoint'].includes(q.intent),'intent_out_of_scope');if(q.turn_id!==undefined&&q.turn_id!==null)requireOk(UUID.test(q.turn_id),'invalid_turn_id');}
function prompt(q){
 const base=q.intent==='checkpoint'?'Sem executar ferramentas, alterar arquivos, enviar notificações ou retomar efeitos, use apenas o contexto já existente desta thread para informar seu checkpoint atual.':'Retome somente o objetivo e o trabalho já autorizados nesta thread relativos ao projeto /mnt/data/docker. Preserve trabalhos concorrentes e autorizações específicas. Este pedido não autoriza novo acesso, uso de credenciais, gastos extras, mudanças de segurança ou efeitos de produção fora dos limites já aprovados. Não repita operações incertas. Pare e peça a decisão exata quando uma nova aprovação for necessária.';
 return base+' Ao responder, devolva somente JSON com operation_id="'+q.operation_id+'", project="/mnt/data/docker", state (checkpoint, progress, blocked ou complete), summary (até 1200 caracteres) e next_step (até 300 caracteres). Não inclua credenciais, IDs privados, títulos/corpos de notificações, prompts, comandos executados ou logs. Não modifique permissões, modelo ou configuração da thread.';
}
function cleanAnswer(text,q){
 if(typeof text!=='string'||Buffer.byteLength(text)>4096)return {answer_withheld:true};
 let v;try{v=JSON.parse(text);}catch{return {answer_withheld:true};}
 if(!v||Object.keys(v).sort().join(',')!=='next_step,operation_id,project,state,summary'||v.operation_id!==q.operation_id||v.project!=='/mnt/data/docker'||!['checkpoint','progress','blocked','complete'].includes(v.state)||typeof v.summary!=='string'||v.summary.length>1200||typeof v.next_step!=='string'||v.next_step.length>300)return {answer_withheld:true};
 const raw=JSON.stringify(v);
 if(/-----BEGIN|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.)|(?:password|token|secret|api_key)\s*[:=]\s*["']?[A-Za-z0-9_+\/-]{12,}|https?:\/\/|(?:192\.168\.|10\.\d+\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(raw))return {answer_withheld:true};
 return {answer:v,answer_withheld:false};
}
function quota(account,usage){
 requireOk(account?.account?.type==='chatgpt'&&['plus','pro','prolite','promax'].includes(account.account.planType),'personal_subscription_required');
 requireOk(usage?.ordinaryUsageAllowed===true,'included_quota_unconfirmed');
 const buckets=[usage.rateLimits,...Object.values(usage.rateLimitsByLimitId||{})];
 for(const b of buckets)requireOk(b&&b.credits?.hasCredits===false&&b.credits?.unlimited===false&&[null,undefined,'0','0.0','0.00'].includes(b.credits?.balance)&&b.rateLimitReachedType==null&&b.spendControlReached!==true,'extra_credit_or_quota_refused');
}
function metadata(t,id){requireOk(t?.id===id&&STATES.has(t.status?.type),'thread_metadata_unconfirmed');return {thread_id:id,status:t.status.type,ephemeral:t.ephemeral===true,cwd_is_project:t.cwd==='/mnt/data/docker',cwd:'/home/gabriel'===t.cwd?'/home/gabriel':t.cwd==='/mnt/data/docker'?'/mnt/data/docker':'other',can_accept_direct_input:t.canAcceptDirectInput===true};}
async function run(q,rpc){
 validate(q);const t=metadata((await rpc('thread/read',{threadId:q.thread_id,includeTurns:false})).thread,q.thread_id);
 if(q.mode==='metadata')return t;
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
 requireOk(t.status==='idle'&&t.can_accept_direct_input,'busy');
 quota(await rpc('account/read',{refreshToken:false}),await rpc('account/rateLimits/read',{}));
 if(q.mode==='preflight')return {...t,included_quota_confirmed:true};
 // Fresh status before sending. Other clients can race; do not claim a global CAS.
 const fresh=metadata((await rpc('thread/read',{threadId:q.thread_id,includeTurns:false})).thread,q.thread_id);
 requireOk(fresh.status==='idle'&&fresh.can_accept_direct_input,'busy');
 const reply=await rpc('turn/start',{threadId:q.thread_id,clientUserMessageId:q.operation_id,input:[{type:'text',text:prompt(q)}]});
 requireOk(UUID.test(reply?.turn?.id),'turn_acceptance_unconfirmed');
 return {thread_id:q.thread_id,operation_state:'accepted',turn_id:reply.turn.id,model_started_or_input_accepted:true};
}
async function connect(q){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket('ws+unix://'+SOCKET+':/',{handshakeTimeout:3000,maxPayload:524288,perMessageDeflate:false});
  const pending=new Map();let next=1,closed=false,total=0;
  function finish(error,value){if(closed)return;closed=true;clearTimeout(timer);for(const p of pending.values())p.reject(new Refused('connection_closed'));pending.clear();ws.terminate();error?reject(error):resolve(value);}
  const timer=setTimeout(()=>finish(new Refused('protocol_timeout')),12000);
  function rpc(method,params){return new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});}
  ws.on('message',raw=>{try{total+=raw.length;requireOk(total<=1048576,'response_limit');const m=JSON.parse(raw);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Refused('rpc_refused')):p.resolve(m.result);}}catch{finish(new Refused('invalid_response'));}});
  ws.on('error',()=>finish(new Refused('connection_failed')));
  ws.on('close',()=>{if(!closed)finish(new Refused('connection_closed'));});
  ws.on('open',async()=>{try{await rpc('initialize',{clientInfo:{name:'raspberry_fixed_thread_control',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));finish(null,await run(q,rpc));}catch(e){finish(e instanceof Refused?e:new Refused('rpc_unconfirmed'));}});
 });
}
module.exports={THREADS,OBSERVATION_THREADS,validate,prompt,quota,metadata,cleanAnswer,run,Refused};
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;if(input.length>4096)process.exit(1);});process.stdin.on('end',async()=>{try{const q=JSON.parse(input);validate(q);console.log(JSON.stringify({ok:true,result:await connect(q)}));}catch(e){console.log(JSON.stringify({ok:false,error:e instanceof Refused?e.message:'adapter_unconfirmed',automatic_retry:false}));process.exitCode=1;}});}
