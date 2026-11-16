// Persist only the five incidents already classified by the visual audience gate.
const test=msg._host_observer_test===true||msg._global_observer_test===true;
const store=test?undefined:'persistent', key=test?'eva_incidents_v1__test':'eva_incidents_v1';
const state=flow.get(key,store)??{};
const policy=flow.get('eva_notice_policy_v1','persistent');
if(!policy)return null;
const now=test?Number(msg.observer_now??msg._host_now??Date.parse(msg.payload?.policy_decided_at)):Date.now();
if(msg._eva_escalation_tick===true){
 const candidates=Object.entries(state).filter(([,v])=>!v.escalated_at).map(([role,v])=>({
  _global_observer_test:test,observer_now:now,_eva_policy:policy,_eva_incident_generation:v.generation,
  _eva_unresolved_ms:Math.max(0,now-v.first_detected_at),
  payload:{...v.payload,policy_decided_at:new Date(now).toISOString()},alert:v.alert
 }));
 return [null,candidates.length?candidates:null];
}
const role=msg.payload?.incident_key;
if(msg.payload?.notification_audience!=='eva_private')return null;
if(msg.payload.persistent_notification_operation==='dismiss'){
 if(state[role]?.escalated_at)msg.payload={...msg.payload,owner_escalation:true,mobile_notification:true};
 delete state[role];
}
else {
 const first=Date.parse(msg.payload.first_detected_at);
 if(!Number.isFinite(first)||first>now)throw Error('eva_incident_clock');
 const generation=msg.payload.first_detected_at;
 if(state[role]?.generation!==generation)state[role]={generation,first_detected_at:first,escalated_at:null,payload:{...msg.payload},alert:{...msg.alert}};
}
flow.set(key,state,store);msg._eva_policy=policy;
return [msg,null];
