const scenario=String(msg.payload), now=Date.now();
if(scenario==='reset'){flow.set('eva_incidents_v1__test',{});return null;}
if(scenario==='tick')return {_global_observer_test:true,_eva_escalation_tick:true,observer_now:now};
if(scenario==='vencer'){
 const state=flow.get('eva_incidents_v1__test')??{},policy=flow.get('eva_notice_policy_v1','persistent');
 if(!policy)return null;for(const row of Object.values(state))row.first_detected_at=now-policy.owner_escalation_ms-1;
 flow.set('eva_incidents_v1__test',state);return null;
}
if(!['novo','recuperar'].includes(scenario))return null;
return {_global_observer_test:true,observer_now:now,payload:{test_mode:true,notification_audience:'eva_private',incident_key:'native_systemd_procmon',persistent_notification_operation:scenario==='recuperar'?'dismiss':'create',first_detected_at:new Date(now).toISOString(),policy_decided_at:new Date(now).toISOString()},alert:{title:'TESTE — incidente privado',message:'TESTE sintético sem entrega ou efeito residencial.'}};
