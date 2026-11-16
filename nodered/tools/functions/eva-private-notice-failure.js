const test=msg._global_observer_test===true||msg.payload?.test_mode===true;
const key=test?'eva_transport_incident_v1__test':'eva_transport_incident_v1',store=test?undefined:'persistent';
const active=flow.get(key,store)===true;
if(msg._eva_transport_ok===true){flow.set(key,false,store);return null;}
if(active)return null;
flow.set(key,true,store);
msg.payload={test_mode:test,observer_kind:'domain_alert',incident_key:'eva_private_transport_unconfirmed',mobile_notification:true};
msg.alert={title:'Entrega privada à Eva não confirmada',message:'O transporte de um aviso técnico não confirmou a revisão dentro do prazo configurado. O aviso foi preservado na fila; verificar o recibo existente antes de repetir qualquer operação.'};
return msg;
