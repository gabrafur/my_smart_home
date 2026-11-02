'use strict';
// Parent runs serially. vm dependency stubs prevent sockets/installed modules.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'task_rpc.cjs'),'utf8');
const moduleMock={exports:{}};
const old={quota:()=>{},metadata:(t,id)=>({thread_id:id,status:t.status.type,cwd_is_project:t.cwd==='/mnt/data/docker',can_accept_direct_input:t.canAcceptDirectInput===true})};
const requireMock=name=>name==='node:net'?{isIP:require('node:net').isIP}:name.includes('vendor/ws')?class {constructor(){throw Error('No actual socket allowed');}}:name.endsWith('codex_control_rpc.cjs')?old:(()=>{throw Error('Unexpected require');})();
requireMock.main={};vm.runInNewContext(source,{require:requireMock,module:moduleMock,process:{},console,Date,Buffer,setTimeout,clearTimeout});
const api=moduleMock.exports,THREAD='00000000-0000-0000-0000-000000000001',TURN='00000000-0000-0000-0000-000000000002',OP='3'.repeat(32);
function fixture(options={}){
 const calls=[];let reads=0;
 const rpc=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/read'){
   reads++;if(options.notLoaded)throw Object.assign(Error('thread not loaded: '+THREAD),{code:-32600});
   return {thread:{id:THREAD,cwd:options.foreign?'/other':'/mnt/data/docker',modelProvider:options.unknownProvider?undefined:options.provider||'openai',ephemeral:false,canAcceptDirectInput:true,status:{type:options.state||(options.change&&reads>1?'idle':'active')}}};
  }
  if(method==='thread/turns/list')return {data:[{id:TURN,status:options.terminal||'inProgress',startedAt:900,completedAt:options.terminal?950:null}]};
  if(method==='thread/items/list')return {data:params.limit===1?[{item:{id:'before',type:'agentMessage',phase:'commentary',text:'Prior item'}}]:options.items||[
   {item:{id:'after',type:'agentMessage',phase:'commentary',text:options.replyText||'ACK '+OP}},
   {item:{id:'before',type:'agentMessage',phase:'commentary',text:'Prior item'}}]};
  if(method==='account/read')return {account:{type:'chatgpt',planType:'pro'}};
  if(method==='account/rateLimits/read')return {};
  if(method==='turn/steer'){
   assert.equal(params.expectedTurnId,TURN);if(options.casError)throw Error('expectedTurnId changed');
   return {turnId:TURN};
  }
  if(method==='turn/start')return {turn:{id:TURN}};
  throw Error('Forbidden unexpected method '+method);
 };
 return {calls,rpc};
}
const send={mode:'workspace_message',thread_id:THREAD,operation_id:OP,text:'Synthetic message',delivery_mode:'active_steer',expected_turn_id:TURN};
test('active steer preserves expected turn and has no profile override',async()=>{const f=fixture();const p=await api.run({mode:'workspace_message_preflight',thread_id:THREAD},f.rpc);assert.equal(p.expected_turn_id,TURN);const r=await api.run(send,f.rpc);assert.equal(r.operation_state,'accepted');assert.equal(r.assistant_acknowledged,false);const call=f.calls.find(c=>c.method==='turn/steer');assert.deepEqual(Object.keys(call.params).sort(),['expectedTurnId','input','threadId']);assert(!f.calls.some(c=>['thread/resume','thread/start','turn/interrupt'].includes(c.method)));assert.equal(r.reply_boundary.item_id,'before');});
test('idle start has native operation key and no permissions/config fields',async()=>{const f=fixture({state:'idle'});const r=await api.run({...send,delivery_mode:'idle_start',expected_turn_id:null},f.rpc);assert.equal(r.operation_state,'accepted');assert.equal(f.calls.at(-1).method,'turn/start');assert.deepEqual(Object.keys(f.calls.at(-1).params).sort(),['clientUserMessageId','input','threadId']);});
test('foreign project and notLoaded refuse without resume or effects',async()=>{for(const option of [{foreign:true},{notLoaded:true}]){const f=fixture(option);await assert.rejects(api.run({mode:'workspace_message_preflight',thread_id:THREAD},f.rpc),/workspace_thread/);assert(!f.calls.some(c=>c.method==='thread/resume'||c.method==='turn/start'||c.method==='turn/steer'));}});
test('unknown or custom provider refuses without changing provider or dispatching',async()=>{for(const option of [{unknownProvider:true},{provider:'custom-paid'}]){const f=fixture(option);await assert.rejects(api.run({mode:'workspace_message_preflight',thread_id:THREAD},f.rpc),/workspace_provider_unconfirmed/);assert(!f.calls.some(c=>c.method==='turn/start'||c.method==='turn/steer'||c.method==='thread/resume'));}});
test('active state change before dispatch refuses rather than changing target mode',async()=>{const f=fixture({change:true});await assert.rejects(api.run(send,f.rpc),/workspace_thread_state_changed/);assert(!f.calls.some(c=>c.method==='turn/start'||c.method==='turn/steer'));});
test('CAS refusal is not retried and no interrupt/start fallback occurs',async()=>{const f=fixture({casError:true});await assert.rejects(api.run(send,f.rpc),/expectedTurnId/);assert.equal(f.calls.filter(c=>c.method==='turn/steer').length,1);assert(!f.calls.some(c=>c.method==='turn/start'||c.method==='turn/interrupt'));});
const observe={mode:'workspace_message_observe',thread_id:THREAD,turn_id:TURN,operation_id:OP,delivery_mode:'active_steer',expected_turn_id:TURN,reply_boundary:{state:'post_delivery_item',item_id:'before'},known_ack:null};
test('receiver completion without reference is not message acknowledgement',async()=>{const f=fixture({terminal:'completed',replyText:'Receiver turn ended'});const r=await api.run(observe,f.rpc);assert.equal(r.operation_state,'completed');assert.equal(r.assistant_acknowledged,null);assert.equal(r.agent_reply.text,'Receiver turn ended');assert.equal(r.completion_scope,'receiver_turn_and_bounded_agent_reply');assert.equal(f.calls.length,2);assert.equal(f.calls[0].params.itemsView,'notLoaded');});
test('active receiver ACK reference after post-send boundary does not mark turn completed',async()=>{const f=fixture();const r=await api.run(observe,f.rpc);assert.equal(r.operation_state,'inProgress');assert.equal(r.assistant_acknowledged,true);assert.equal(r.agent_reply.text,'ACK '+OP);assert.equal(r.acknowledgement_evidence.item_id,'after');});
test('missing boundary or reference before boundary leaves acknowledgement unknown',async()=>{for(const items of [[{item:{id:'after',type:'agentMessage',text:'ACK '+OP}}],[{item:{id:'before',type:'agentMessage',text:'Prior item'}},{item:{id:'old',type:'agentMessage',text:'ACK '+OP}}]]){const f=fixture({items});const r=await api.run(observe,f.rpc);assert.equal(r.assistant_acknowledged,null);assert.equal(r.agent_reply.text,null);assert.equal(r.agent_reply.collection_error,'agent_reply_after_delivery_not_proven');}});
test('sensitive reply is withheld without tool or system content export',async()=>{const secret='ACK '+OP+' password=DO_NOT_EXPORT';const f=fixture({replyText:secret});const r=await api.run(observe,f.rpc);assert.equal(r.agent_reply.text,null);assert.equal(r.agent_reply.state,'withheld');assert(!JSON.stringify(r).includes('DO_NOT_EXPORT'));assert.equal(r.assistant_acknowledged,true);});
test('recorded verified acknowledgement is retained if bounded page later omits reply',async()=>{const f=fixture({replyText:'Later unrelated message'});const known={source:'exact_operation_reference_after_delivery',operation_id:OP,turn_id:TURN,item_id:'after'};const r=await api.run({...observe,known_ack:known},f.rpc);assert.equal(r.assistant_acknowledged,true);assert.equal(r.agent_reply.text,null);assert.equal(r.acknowledgement_evidence.item_id,'after');});
test('communication routes cannot carry profile or arbitrary parameters',async()=>{for(const bad of [{...send,profile:'eva_admin'},{...send,sandbox:'danger-full-access'},{...send,expected_turn_id:null},{...send,delivery_mode:'interrupt'}]){const f=fixture();await assert.rejects(api.run(bad,f.rpc));assert.equal(f.calls.length,0);}});

test('Portuguese authentication code replies remain withheld',async()=>{for(const fragment of ['código: 123456','código de verificação: 123456','codigo de autenticacao = 123456']){const f=fixture({replyText:'ACK '+OP+' '+fragment});const r=await api.run(observe,f.rpc);assert.equal(r.agent_reply.text,null);assert.equal(r.agent_reply.state,'withheld');assert(!JSON.stringify(r).includes('123456'));}});

test('ordinary code discussion is not mistaken for an authentication code',async()=>{const text='ACK '+OP+' Revisei o código do parser sem reiniciar serviços.';const f=fixture({replyText:text});const r=await api.run(observe,f.rpc);assert.equal(r.agent_reply.text,text);assert.equal(r.assistant_acknowledged,true);});
