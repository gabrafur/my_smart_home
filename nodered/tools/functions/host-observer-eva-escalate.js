// Called only after the visual unresolved-duration gate; durable once-per-incident intent.
const test=msg._global_observer_test===true,store=test?undefined:'persistent';
const key=test?'eva_incidents_v1__test':'eva_incidents_v1';const state=flow.get(key,store)??{};
const row=state[msg.payload?.incident_key];
if(!row||row.generation!==msg._eva_incident_generation||row.escalated_at)return null;
row.escalated_at=new Date(test?Number(msg.observer_now):Date.now()).toISOString();
flow.set(key,state,store);
msg.payload={...msg.payload,owner_escalation:true,mobile_notification:true};
msg.alert={title:'Incidente técnico ainda sem solução',message:'A Eva recebeu este incidente, mas ele continua pendente além do prazo configurado. '+String(row.alert.message)};
return msg;
