// Explicit private delivery proof; its lifecycle never enters the real incident registry.
const key='eva_private_delivery_test_v1';
let state=flow.get(key,'persistent');
const ack=msg._eva_private_test_ack;
if(ack){
 if(!state)return null;
 if(state.phase==='create_pending'&&ack.operation==='create'&&ack.created_at===state.created_at&&/^[a-f0-9]{64}$/.test(ack.revision)){
  state={...state,phase:'active',accepted_revision:ack.revision};flow.set(key,state,'persistent');
 }else if(state.phase==='cleanup_pending'&&ack.operation==='dismiss'&&ack.previous_revision===state.accepted_revision&&/^[a-f0-9]{64}$/.test(ack.revision)){
  state={...state,phase:'complete',cleanup_revision:ack.revision};flow.set(key,state,'persistent');
 }
 return null;
}
const operation=msg.payload;
if(!['create','dismiss'].includes(operation))throw Error('eva_test_operation');
const policy=flow.get('eva_notice_policy_v1','persistent');
if(!policy)throw Error('eva_test_policy_missing');
if(operation==='create'){
 if(state&&['active','cleanup_pending'].includes(state.phase))return null;
 if(!state||state.phase==='complete'){
  state={phase:'create_pending',created_at:new Date().toISOString()};flow.set(key,state,'persistent');
 }
}else{
 if(!state||!['active','cleanup_pending'].includes(state.phase))return null;
 state={...state,phase:'cleanup_pending'};flow.set(key,state,'persistent');
}
return {_global_observer_test:true,_eva_private_delivery_test:true,_eva_policy:{...policy},
 payload:{test_mode:true,notification_delivery_under_test:true,notification_audience:'eva_private',incident_key:'delivery_test',mobile_notification:false,persistent_notification_operation:operation,policy_decided_at:state.created_at},
 alert:{title:'TESTE — entrega privada à Eva',message:'TESTE de transporte privado solicitado pelo proprietário. Não representa incidente residencial. Identificador: '+state.created_at}};
