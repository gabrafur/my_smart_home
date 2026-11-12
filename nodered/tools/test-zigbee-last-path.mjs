import assert from 'node:assert/strict';
import {harness,flows} from './startup-replay-harness.mjs';
assert.ok(flows.some(n=>n.id==='zigbee_coordinator_recovery_tab'&&n.type==='tab'),'monitor generator must preserve coordinator recovery canvas');
const tab='monitoramento_zigbee_tab',t=Date.UTC(2026,0,1)+200000;
const fn=id=>new Function('msg','flow','node','global',flows.find(n=>n.id===id).func);
const noop={status(){}};
const h=harness(),flow=h.flowFor(tab);
await h.run('zigbee_policy_default',{});await h.run('zigbee_test_reset',{});
await h.run('zigbee_path_test_policy',{});await h.run('zigbee_path_test_map',{});
assert.equal(Object.keys(flow.get('zigbee_paths_v1__test')).length,1);
const productionBefore=JSON.stringify([...flow.values].filter(([k])=>k.startsWith('persistent:')));
await h.run('zigbee_test_net_online',{});await h.run('zigbee_test_route_failure',{});await h.run('zigbee_test_route_scan_response',{});
const effects=()=>h.dry.filter(d=>d.msg.zigbee_route_effect==='configure').map(d=>d.msg.payload);
assert.equal(effects().length,1);assert.equal(effects()[0].id,'router_test');
await h.run('zigbee_path_test_hop_0',{});assert.equal(effects().length,2);assert.equal(effects()[1].id,'teste_rota');
assert.notEqual(effects()[0].transaction,effects()[1].transaction);
await h.run('zigbee_path_test_hop_0',{});assert.equal(effects().length,2,'duplicate upstream ack cannot repeat a command');
await h.run('zigbee_path_test_hop_1',{});
let incident=Object.values(flow.get('zigbee_route_incidents_v1__test'))[0];assert.equal(incident.phase,'verifying');assert.equal(incident.incident_open,true,'configure success is not recovery');
await h.run('zigbee_settle_test_live',{});await h.run('zigbee_settle_test_tick',{});
assert.equal(Object.values(flow.get('zigbee_route_incidents_v1__test'))[0].phase,'recovered');
assert.equal(JSON.stringify([...flow.values].filter(([k])=>k.startsWith('persistent:'))),productionBefore,'dry-run never changes production lifecycle');
assert.ok(!h.seen.some(id=>['zigbee_route_recovery_mqtt','zigbee_route_configure_mqtt','zigbee_path_scan_mqtt','zigbee_notify_effect'].includes(id)));
// Historical uncertain effects cannot freeze read-only topology collection;
// collection never releases or replays the uncertain configure operation.
{
 const x=harness(),f=x.flowFor(tab),now=t+4000000;
 await x.run('zigbee_policy_default',{});await x.run('zigbee_path_test_policy',{});
 f.set('zigbee_boot_at__test',t);f.set('zigbee_bridge_observation__test',{state:'online',changed_at:t});
 const uncertain={old:{incident_open:true,native_completion_state:'unknown',pending_transaction:null}};
 f.set('zigbee_route_incidents_v1__test',uncertain);
 const guard={schema_version:1,observed_at:now,running:true,maintenance_active:false,blocked_unknown:false,operation_active:false,invalid_param_count:0};
 for(const bad of [{maintenance_active:true},{blocked_unknown:true},{operation_active:true},{invalid_param_count:3},{observed_at:now-90001}]){
  await x.run('zigbee_path_clock',{_zigbee_test:true,monitor_now:now,guard_test_facts:{...guard,...bad}});assert.equal(x.dry.length,0);
 }
 await x.run('zigbee_path_clock',{_zigbee_test:true,monitor_now:now,guard_test_facts:guard});
 assert.equal(x.dry.filter(d=>d.msg.zigbee_route_effect==='route_scan').length,1);
 assert.ok(!x.seen.includes('zigbee_path_guard_file'));
 await x.run('zigbee_path_clock',{_zigbee_test:true,monitor_now:now+1,guard_test_facts:guard});
 assert.equal(x.dry.filter(d=>d.msg.zigbee_route_effect==='route_scan').length,1,'pending map cannot overlap');
 assert.deepEqual(f.get('zigbee_route_incidents_v1__test'),uncertain);
 const oldTransaction=f.get('zigbee_path_scan__test').transaction,restarted=harness(),rf=restarted.flowFor(tab);
 for(const [key,value] of f.values)rf.values.set(key,structuredClone(value));
 const later=now+3600001;
 await restarted.run('zigbee_path_clock',{_zigbee_test:true,monitor_now:later,guard_test_facts:{...guard,observed_at:later}});
 assert.equal(restarted.dry.filter(d=>d.msg.zigbee_route_effect==='route_scan').length,1,'restart can renew only the read after its cadence');
 assert.notEqual(rf.get('zigbee_path_scan__test').transaction,oldTransaction);
 assert.ok(rf.get('zigbee_path_scan__test').unknown_transactions.includes(oldTransaction));
 assert.deepEqual(rf.get('zigbee_route_incidents_v1__test'),uncertain,'uncertain configure operations stay blocked');
 assert.equal(fn('zigbee_path_map_normalize')({_zigbee_test:true,monitor_now:later+1,payload:{transaction:oldTransaction,status:'ok',data:{value:{nodes:[],links:[]}}}},rf,noop,{}),null,'late old map cannot settle the new observation');

}
// A failed intermediate never dispatches the target or reports recovery.
{
 const x=harness(),f=x.flowFor(tab);await x.run('zigbee_policy_default',{});await x.run('zigbee_path_test_policy',{});await x.run('zigbee_path_test_map',{});await x.run('zigbee_test_net_online',{});await x.run('zigbee_test_route_failure',{});await x.run('zigbee_test_route_scan_response',{});
 const first=x.dry.find(d=>d.msg.zigbee_route_effect==='configure').msg.payload;
 await x.run('zigbee_route_response_source',{_zigbee_test:true,monitor_now:t+5000,topic:'zigbee2mqtt/bridge/response/device/configure',payload:{transaction:first.transaction,status:'error',error:'synthetic upstream unavailable'}});
 assert.equal(x.dry.filter(d=>d.msg.zigbee_route_effect==='configure').length,1);
 assert.equal(Object.values(f.get('zigbee_route_incidents_v1__test'))[0].phase,'failed');
}
// Incomplete maps cannot erase a known route; unrelated/retained maps cannot create one.
const map=flow.get('zigbee_paths_v1__test'),before=JSON.stringify(map);
const normalize=fn('zigbee_path_map_normalize'),save=(m,f,n,g)=>fn('zigbee_path_map_store')(fn('zigbee_path_map_parents')(fn('zigbee_path_map_extract')(fn('zigbee_path_map_catalog')(m,f,n,g),f,n,g),f,n,g),f,n,g);
const scan=(value,retain=false,tx='nodered-zigbee-path-test-next')=>{
 flow.set('zigbee_path_scan__test',{transaction:'nodered-zigbee-path-test-next',at:t,pending:true});
 const m=normalize({_zigbee_test:true,monitor_now:t+1,retain,payload:{transaction:tx,status:'ok',data:{value}}},flow,noop,{});
 if(m)save(m,flow,noop,{});return m;
};
scan({nodes:[],links:[]});assert.equal(JSON.stringify(flow.get('zigbee_paths_v1__test')),before);
assert.equal(scan({nodes:[],links:[]},true),null);assert.equal(scan({nodes:[],links:[]},false,'unrelated'),null);
// Native uplink-only tables are reversed into an upstream-first recovery plan.
{
 const x=harness(),f=x.flowFor(tab);const co='0x0000000000000001',router='0x0000000000000002',device='0x0000000000000003';
 const value={nodes:[{ieeeAddr:co,friendlyName:'co',type:'Coordinator',networkAddress:0},{ieeeAddr:router,friendlyName:'router',type:'Router',networkAddress:2},{ieeeAddr:device,friendlyName:'device',type:'Router',networkAddress:3}],links:[{target:{ieeeAddr:device},source:{ieeeAddr:router,networkAddress:2},lqi:100,routes:[{status:'ACTIVE',destinationAddress:0,nextHopAddress:2}]},{target:{ieeeAddr:router},source:{ieeeAddr:co,networkAddress:0},lqi:100,routes:[{status:'ACTIVE',destinationAddress:0,nextHopAddress:0}]}]};
 f.set('zigbee_path_scan__test',{transaction:'nodered-zigbee-path-test-uplink',pending:true,at:t});
 const m=normalize({_zigbee_test:true,monitor_now:t+1,payload:{transaction:'nodered-zigbee-path-test-uplink',status:'ok',data:{value}}},f,noop,{});save(m,f,noop,{});
 assert.deepEqual(f.get('zigbee_paths_v1__test')[device].path,[co,router,device]);assert.equal(f.get('zigbee_paths_v1__test')[device].direction,'toward_coordinator');
 const leaf='0x0000000000000004';value.nodes.push({ieeeAddr:leaf,friendlyName:'leaf',type:'EndDevice',networkAddress:4});value.links.push({source:{ieeeAddr:leaf,networkAddress:4},target:{ieeeAddr:router,networkAddress:2},relationship:1,lqi:100,routes:[]});
 // A fresh catalog observation is authoritative for the additional device.
 const catalog=f.get('zigbee_device_catalog_v1__test');catalog[leaf]={name:'leaf',type:'EndDevice'};f.set('zigbee_device_catalog_v1__test',catalog);
 save({zigbee_path_map:value,_zigbee_test:true,monitor_now:t+2},f,noop,{});
 assert.deepEqual(f.get('zigbee_paths_v1__test')[leaf].path,[co,router,leaf]);assert.equal(f.get('zigbee_paths_v1__test')[leaf].kind,'parent_and_active_routing_table');

}
// Stale/foreign paths fall through the actual visual gate to direct configure.
for(const [label,mutate,now] of [
 ['stale',p=>p,t+1440*60000+1],
 ['foreign coordinator',p=>({...p,coordinator:'0x0000000000000009'}),t+1000],
 ['cycle',p=>({...p,path:[p.coordinator,p.coordinator,p.ieee]}),t+1000],
]){
 const x=harness(),f=x.flowFor(tab);await x.run('zigbee_path_test_policy',{});await x.run('zigbee_path_test_map',{});
 const old=f.get('zigbee_paths_v1__test'),ieee=Object.keys(old)[0];f.set('zigbee_paths_v1__test',{[ieee]:mutate({...old[ieee],observed_at:t})});
 await x.run('zigbee_policy_default',{});await x.run('zigbee_test_net_online',{});
 await x.run('zigbee_route_error_source',{_zigbee_test:true,monitor_now:now,payload:{level:'error',message:"Publish 'get' 'state' to 'teste_rota' failed: NWK_NO_ROUTE"}});
 const scan=x.dry.find(d=>d.msg.zigbee_route_effect==='route_scan');assert.ok(scan,label);
 await x.run('zigbee_route_scan_response_source',{_zigbee_test:true,monitor_now:now+1,topic:'zigbee2mqtt/bridge/response/networkmap',payload:{status:'ok',transaction:scan.msg.payload.transaction}});
 assert.ok(x.seen.includes('zigbee_path_direct'),label);
 assert.deepEqual(x.dry.filter(d=>d.msg.zigbee_route_effect==='configure').map(d=>d.msg.payload.id),['teste_rota'],label);
}
// Offline confirmation enters the same bounded route policy without duplicate alert.
const offline=fn('zigbee_path_offline')({_zigbee_test:true,zigbee_component_action:'open',zigbee_component_key:'sample',zigbee_component:'teste_rota',zigbee_now:t,zigbee_now_iso:new Date(t).toISOString()},flow,noop,{});
assert.equal(offline.zigbee_path_policy.offline_recovery,true);assert.equal(offline.zigbee_route_quiet_open,true);
const quiet=harness();await quiet.run('zigbee_path_offline_ok',{...offline,zigbee_component_action:'touch'});assert.ok(!quiet.seen.includes('zigbee_path_offline_recover'));
console.log('Last Zigbee path: active-route history, upstream-before-target, per-hop correlation, stale/foreign/loop rejection, missing-map preservation, offline policy and full dry-run passed.');
