import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import test from 'node:test';
const body=fs.readFileSync(new URL('functions/global-flow-observer-dispatch-guard.js',import.meta.url),'utf8');
const run=msg=>vm.runInNewContext('(function(){'+body+'})()',{msg});
test('private incident never reaches HA/mobile',()=>{const r=run({_eva_policy:{delivery_mode:'exclusive'},payload:{notification_audience:'eva_private',incident_key:'native_systemd_procmon'}});assert.equal(r.length,4);assert.equal(r[0],null);assert.equal(r[1],null);assert.ok(r[3]);});
test('explicit owner escalation retains both existing channels',()=>{const r=run({payload:{notification_audience:'eva_private',owner_escalation:true}});assert.ok(r[0]);assert.ok(r[1]);assert.ok(r[3]);});
test('muted mobile alone does not classify a private event',()=>{const r=run({payload:{mobile_notification:false}});assert.equal(r[0],null);assert.ok(r[1]);assert.equal(r[3],undefined);});
test('dry run does not reach private exporter',()=>{const r=run({payload:{test_mode:true,notification_audience:'eva_private'}});assert.ok(r[2]);assert.equal(r[3],undefined);});
const registryBody=fs.readFileSync(new URL('functions/host-observer-eva-registry.js',import.meta.url),'utf8');
const escalateBody=fs.readFileSync(new URL('functions/host-observer-eva-escalate.js',import.meta.url),'utf8');
const invoke=(body,msg,db)=>vm.runInNewContext('(function(){'+body+'})()',{msg,flow:{get:k=>db[k],set:(k,v)=>db[k]=v},node:{status(){}}});
test('escalation survives turn/restart, deduplicates and resets on recovery',()=>{
 const db={eva_notice_policy_v1:{owner_escalation_ms:86400000,audit_retention_days:30,transport_confirm_ms:120000,delivery_mode:'shadow'}};
 const event={_global_observer_test:true,observer_now:1000,payload:{incident_key:'native_systemd_procmon',notification_audience:'eva_private',persistent_notification_operation:'create',first_detected_at:new Date(1000).toISOString()},alert:{title:'test',message:'detail'}};
 assert.ok(invoke(registryBody,event,db)[0]);
 const resumed=JSON.parse(JSON.stringify(db));
 const tick={_global_observer_test:true,_eva_escalation_tick:true,observer_now:86401000};
 const candidate=invoke(registryBody,tick,resumed)[1][0];assert.equal(candidate._eva_unresolved_ms,86400000);
 const escalated=invoke(escalateBody,candidate,resumed);assert.equal(escalated.payload.owner_escalation,true);
 assert.equal(invoke(escalateBody,candidate,resumed),null);
 assert.equal(invoke(registryBody,tick,resumed)[1],null);
 invoke(registryBody,{...event,payload:{...event.payload,persistent_notification_operation:'dismiss'}},resumed);
 assert.equal(invoke(registryBody,tick,resumed)[1],null);
});
test('transport failure notifies owner once and is dismissed after exact ack',()=>{
 const source=fs.readFileSync(new URL('functions/eva-private-notice-failure.js',import.meta.url),'utf8');
 const db={},msg={_global_observer_test:true,_eva_transport_ok:false};
 const first=invoke(source,structuredClone(msg),db);assert.equal(first.payload.mobile_notification,true);assert.equal(first.payload.notification_audience,undefined);
 assert.equal(invoke(source,structuredClone(msg),db),null);
 const recovered=invoke(source,{...msg,_eva_transport_ok:true},db);
 assert.equal(recovered.payload.persistent_notification_operation,'dismiss');
 assert.equal(recovered.payload.persistent_incident_kind,'domain_alert');
 assert.equal(recovered.payload.incident_key,'eva_private_transport_unconfirmed');
 assert.equal(recovered.payload.mobile_notification,false);
 assert.equal(invoke(source,{...msg,_eva_transport_ok:true},db),null,'healthy receipts never repeat the dismiss');
 assert.ok(invoke(source,structuredClone(msg),db));
});

test('host diagnostics opt out of the HA shadow copy, escalation still reaches the owner',()=>{
 const eva=run({payload:{notification_audience:'eva_private',shadow_fallback:false,incident_key:'native_docker_homeassistant'}});
 assert.deepEqual([eva[0],eva[1],eva[2]],[null,null,null]);assert.ok(eva[3]);
 const escalated=run({payload:{notification_audience:'eva_private',shadow_fallback:false,owner_escalation:true}});
 assert.ok(escalated[0]);assert.ok(escalated[1]);assert.ok(escalated[3]);
});
test('shadow preserves previous source until exact alias proof',()=>{const r=run({payload:{notification_audience:'eva_private'}});assert.equal(r[0],null);assert.ok(r[1]);assert.ok(r[3]);});
const deliveryBody=fs.readFileSync(new URL('functions/host-observer-eva-delivery-test.js',import.meta.url),'utf8');
test('explicit private delivery remains private in shadow and rejects real role',()=>{
 const m={_eva_private_delivery_test:true,payload:{test_mode:true,notification_delivery_under_test:true,notification_audience:'eva_private',incident_key:'delivery_test'}};
 const r=run(m);assert.equal(r[0],null);assert.equal(r[1],null);assert.equal(r[2],null);assert.ok(r[3]);
 assert.throws(()=>run({...m,payload:{...m.payload,incident_key:'native_systemd_procmon'}}),/private_delivery_test_scope/);
});
test('private delivery resumes exact pending identity and cleans only after matching acknowledgement',()=>{
 const db={eva_notice_policy_v1:{delivery_mode:'shadow',audit_retention_days:30,transport_confirm_ms:120000}};
 const first=invoke(deliveryBody,{payload:'create'},db);
 assert.equal(first.payload.incident_key,'delivery_test');assert.match(first.alert.title,/^TESTE/);
 const resumed=JSON.parse(JSON.stringify(db));
 assert.equal(invoke(deliveryBody,{payload:'create'},resumed).payload.policy_decided_at,first.payload.policy_decided_at);
 assert.equal(invoke(deliveryBody,{payload:'dismiss'},resumed),null);
 invoke(deliveryBody,{_eva_private_test_ack:{operation:'create',created_at:'wrong',revision:'a'.repeat(64)}},resumed);
 assert.equal(resumed.eva_private_delivery_test_v1.phase,'create_pending');
 invoke(deliveryBody,{_eva_private_test_ack:{operation:'create',created_at:first.payload.policy_decided_at,revision:'a'.repeat(64)}},resumed);
 assert.equal(invoke(deliveryBody,{payload:'create'},resumed),null);
 const cleanup=invoke(deliveryBody,{payload:'dismiss'},resumed);assert.equal(cleanup.payload.persistent_notification_operation,'dismiss');
 invoke(deliveryBody,{_eva_private_test_ack:{operation:'dismiss',previous_revision:'b'.repeat(64),revision:'c'.repeat(64)}},resumed);
 assert.equal(resumed.eva_private_delivery_test_v1.phase,'cleanup_pending');
 invoke(deliveryBody,{_eva_private_test_ack:{operation:'dismiss',previous_revision:'a'.repeat(64),revision:'c'.repeat(64)}},resumed);
 assert.equal(resumed.eva_private_delivery_test_v1.phase,'complete');assert.equal(Object.keys(resumed).length,2);
});

const exportBody=fs.readFileSync(new URL('functions/eva-private-notice-export.js',import.meta.url),'utf8');
test('exporter mirrors exactly the roles the root spool accepts',()=>{
 const listed=src=>[...src.matchAll(/'([a-z][a-z0-9_-]+)'/g)].map(m=>m[1]);
 const exporter=listed(exportBody.match(/const roles = new Set\(\[[^\]]*\]/)[0]);
 const spool=listed(fs.readFileSync(new URL('../../scripts/raspberry-mcp/eva-notice-transport/consume.py',import.meta.url),'utf8').match(/^ROLES = \([^)]*\)/m)[0]);
 assert.deepEqual(exporter,spool);
});
test('a host incident outside the private mirror is skipped without an error or file access',()=>{
 for(const operation of ['create','dismiss']){
  const statuses=[];
  const fsTrap=new Proxy({},{get(){throw Error('file access');}});
  const out=vm.runInNewContext('(function(){'+exportBody+'})()',{msg:{payload:{incident_key:'native_docker_appdaemon',notification_audience:'eva_private',persistent_notification_operation:operation}},fs:fsTrap,crypto:fsTrap,node:{status:s=>statuses.push(s)},Buffer});
  assert.deepEqual(JSON.parse(JSON.stringify(out._eva_private_result)),{dispatched:false,state:'not_mirrored'});
  assert.equal(statuses.length,1);
 }
 assert.throws(()=>vm.runInNewContext('(function(){'+exportBody+'})()',{msg:{payload:{incident_key:'native_docker_appdaemon',notification_audience:'other',persistent_notification_operation:'create'}},node:{status(){}}}),/eva_export_contract/);
});
