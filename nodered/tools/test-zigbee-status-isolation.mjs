// Source replay only; no network/native runtime access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const tools=new URL('./',import.meta.url);
const candidate=new URL('../flows.json',tools);
let source=fs.readFileSync(new URL('startup-replay-harness.mjs',tools),'utf8');
source=source.replace("new URL('../package.json',import.meta.url)",`new URL('${new URL('../package.json',tools).href}')`)
 .replace("new URL('../flows.json',import.meta.url)",`new URL('${candidate.href}')`)
 .replace('const dry=[];const seen=[];','const dry=[];const seen=[];const statusCalls=[];const warnCalls=[];')
 .replace('status(){},warn(){},log(x){logs.push(x)}','status(value){statusCalls.push({id,value})},warn(value){warnCalls.push({id,value})},log(x){logs.push(x)}')
 .replace('return {run,flowFor,global,dry,seen,by,','return {run,flowFor,global,dry,seen,by,statusCalls,warnCalls,');
assert.ok(source.includes('statusCalls.push'),'instrumentation must match actual harness');
const {flows,harness}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const rows=new Map(flows.map(n=>[n.id,n])),tab='monitoramento_zigbee_tab';
const statusNodes=flows.filter(n=>n.z===tab&&n.type==='function'&&n.func.includes('node.status('));
assert.equal(statusNodes.length,22);
const unreachable=new Set(['zigbee_policy_store','zigbee_policy_reject','zigbee_device_map_store','zigbee_notify_effect__contract_reject']);
for(const n of statusNodes.filter(n=>!unreachable.has(n.id)))assert.match(n.func,/if \(msg\._zigbee_test !== true\) node\.status\(/,n.id);
for(const id of ['zigbee_test_route_scan_response','zigbee_test_route_scan_retry_response','zigbee_test_route_failed_response','zigbee_test_route_success_response'])
 assert.ok(rows.get(id).props.some(p=>p.p==='_zigbee_test'&&p.v==='true'&&p.vt==='bool'),id+' must mark invalid replies synthetic too');
const h=harness(),f=h.flowFor(tab);await h.run('zigbee_policy_default',{});h.statusCalls.length=0;h.warnCalls.length=0;
const productionBefore=JSON.stringify([...f.values].filter(([k])=>k.startsWith('persistent:')));
// Existing manual nodes only; their built-in props, including every test marker, are exercised.
for(const n of flows.filter(n=>n.type==='inject'&&(n.id.startsWith('zigbee_test_')||n.id.startsWith('zigbee_settle_test_'))))
 await h.run(n.id,{});
// Every generated status terminal must also suppress invalid/out-of-order synthetic messages.
const inline=statusNodes.filter(n=>!['zigbee_route_state_mutate','zigbee_test_reset_state','zigbee_dry_run_terminal','zigbee_policy_store','zigbee_policy_reject','zigbee_device_map_store','zigbee_notify_effect__contract_reject'].includes(n.id));
for(const n of inline)await h.run(n.id,{_zigbee_test:true});
assert.equal(h.statusCalls.length,0,'synthetic status must never reach global observer');
assert.equal(h.warnCalls.length,0,'closed replay must not emit ordinary logs');
assert.equal(JSON.stringify([...f.values].filter(([k])=>k.startsWith('persistent:'))),productionBefore,'production flow context untouched');
assert.ok(h.dry.length>0);
for(const forbidden of ['zigbee_route_recovery_mqtt','zigbee_route_configure_mqtt','zigbee_mqtt_publish','zigbee_notify_effect'])assert.ok(!h.seen.includes(forbidden),forbidden);
for(const n of inline)await h.run(n.id,{_zigbee_test:false});
assert.equal(h.statusCalls.length,inline.length,'production status remains observable');
// Preserve the global observer contract: function status is unmonitored, but its cleanup writes production.
const normalize=fs.readFileSync(new URL('functions/global-flow-observer-normalize.js',tools),'utf8');
const unmonitored=fs.readFileSync(new URL('functions/global-flow-observer-status-unmonitored.js',tools),'utf8');
const values=new Map(),key='monitoramento_zigbee_tab:synthetic_source',state={version:2,errors:{},status_sources:{[key]:{old:true}},status_incidents:{},connection_events:{}};
values.set('persistent:global_observer_policy_v1',{version:1,complete:true,connection_recovery_grace_seconds:0});
values.set('persistent:global_flow_observer_v1',state);
let writes=0;const flow={get:(k,s='default')=>values.get(s+':'+k),set:(k,v,s='default')=>{values.set(s+':'+k,v);writes++}};
let msg={status:{fill:'blue',text:'test terminal',source:{id:'synthetic_source',type:'function'}},_global_observer:{flow_id:tab}};
msg=new Function('msg','flow','node','global',normalize)(msg,flow,{status(){}},{get(){}});
assert.equal(msg._observer_event.monitored,false);
new Function('msg','flow','node',unmonitored)(msg,flow,{});
assert.ok(writes>0);assert.equal(state.status_sources[key],undefined,'producer silence is needed even for blue status');
console.log(JSON.stringify({status_producers_guarded:18,manual_roots:21,production_status_preserved:true,
 synthetic_status_callbacks:0,synthetic_warn_callbacks:0,external_effect_nodes_reached:0,RF_commands:0,native_acceptance:false}));
