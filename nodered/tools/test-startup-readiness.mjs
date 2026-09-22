import assert from 'node:assert/strict';
import {harness,flows} from './startup-replay-harness.mjs';
import {STARTUP_GUARDS,STARTUP_TAB,STARTUP_SUBFLOW} from './install-startup-readiness.mjs';
const h=harness();const f=h.flowFor(STARTUP_TAB);const t=1000000;
await h.run('startup_policy_default',{});
assert.equal(f.get('startup_policy_v1','persistent').boot_grace_s,180);
const policy=structuredClone(f.get('startup_policy_v1','persistent'));
await h.run('startup_policy_validate',{payload:{...policy,boot_grace_s:0}});
assert.deepEqual(f.get('startup_policy_v1','persistent'),policy,'invalid policy preserves last valid value');
await h.run('startup_test_reset',{});
async function observe(source,state,at,retain=false){await h.run('startup_observe',{_startup_test:true,startup_source:source,payload:state,startup_now:at,retain})}
const state=()=>f.get('startup_lifecycle_v1__test','memoryOnly');
await observe('internet','online',t,true);await observe('vpn','online',t,true);assert.equal(state().ready,false,'retained online is not readiness');
await observe('internet','online',t+60000);assert.equal(state().reason,'waiting_vpn');
await observe('vpn','online',t+60000);assert.equal(state().ready,false);
await observe('internet','online',t+179999);await observe('vpn','online',t+179999);assert.equal(state().ready,false);
await observe('internet','online',t+180000);assert.equal(state().ready,true,'exact stability and boot boundaries');
await observe('vpn','offline',t+181000);assert.equal(state().ready,false);
await observe('vpn','online',t+182000);assert.equal(state().ready,false,'flap restarts stabilization');
await observe('internet','online',t+302000);await observe('vpn','online',t+302000);assert.equal(state().ready,true);
await h.run('startup_facts',{_startup_test:true,startup_now:t+423000});assert.equal(state().ready,false,'missing producer heartbeat becomes unknown');
assert.equal(h.global.get('startup_readiness_v1','memoryOnly'),undefined,'dry-run does not change production readiness');
assert.ok(h.dry.every(x=>x.msg.payload.simulated===true&&x.msg.payload.dispatched===false));
// A fresh runtime cannot use the preceding runtime's readiness.
await h.run('startup_test_reset',{});await h.run('startup_facts',{_startup_test:true,startup_now:t+500000});assert.equal(state().ready,false);
const gate=h.flowFor(STARTUP_SUBFLOW);gate.set('startup_test_readiness',{ready:false},'memoryOnly');
await h.run('startup_gate_buffer',{_startup_test:true,startup_now:t,job:'first'});
await h.run('startup_gate_buffer',{_startup_test:true,startup_now:t+1,job:'latest'});
assert.equal(gate.get('startup_pending__test','memoryOnly').message.job,'latest');
const dryBefore=h.dry.length;
gate.set('startup_test_readiness',{ready:true,ready_since:t},'memoryOnly');
await h.run('startup_gate_buffer',{_startup_test:true,_startup_tick:true,startup_now:t+200000});assert.equal(h.dry.length,dryBefore+1);
await h.run('startup_gate_buffer',{_startup_test:true,_startup_tick:true,startup_now:t+200001});assert.equal(h.dry.length,dryBefore+1,'consumed request cannot release twice');
gate.set('startup_test_readiness',{ready:false},'memoryOnly');
await h.run('startup_gate_buffer',{_startup_test:true,startup_now:t+200002,job:'expired'});
await h.run('startup_gate_buffer',{_startup_test:true,_startup_tick:true,startup_now:t+200002+policy.pending_ttl_s*1000});assert.equal(gate.get('startup_pending__test','memoryOnly'),undefined);
for(const [id] of STARTUP_GUARDS){const n=h.by.get('startup_caller_'+id);assert.equal(n.type,'subflow:'+STARTUP_SUBFLOW);assert.ok(n.startup_original_wires.flat().length,'released intent re-enters existing decisions')}
const protectedLabels=['monitoramento_internet','monitoramento_vpn','garagem','alarme_casa','iluminacao_seguranca','iluminacao_externa'];
const protectedTabs=new Set(flows.filter(n=>n.type==='tab'&&protectedLabels.includes(n.label)).map(n=>n.id));
assert.ok(!flows.some(n=>n.type==='subflow:'+STARTUP_SUBFLOW&&protectedTabs.has(n.z)),'bootstrap monitors and local protections stay independent');
assert.equal(h.by.get('startup_worker_confirm').duration,'60');
assert.equal(h.by.get('startup_worker_confirm').bytopic,'topic','manual tests cannot cancel production confirmation');
await h.run('global_observer_policy_validate',{topic:'connection_recovery_grace_seconds',payload:90});
// Match Node-RED output semantics: all three publications reach the one wired output.
const publicationStart=h.dry.length;
await h.run('internet_publications_expand',{_internet_test:true,internet_publications:[
  {topic:'nodered/infrastructure/internet/connection',payload:'ON'},
  {topic:'nodered/infrastructure/internet/attributes',payload:'{}'},
  {topic:'nodered/infrastructure/internet/state',payload:'online'}
]});
assert.equal(h.dry.length,publicationStart+3,'all canonical internet publications reach their dry-run boundary');
for(const tab of new Set([STARTUP_TAB,'monitoramento_internet_tab',...STARTUP_GUARDS.map(([id])=>h.by.get(id).z)])) {
  const before=h.dry.length;
  await h.run('global_observer_coverage__'+tab+'__annotate',{_global_observer_test:true,observer_now:t,error:{message:'synthetic startup replay',source:{id:'synthetic',type:'function',name:'Replay'}}});
  assert.equal(h.dry.length,before+1,'functional tab failure reaches shared dry-run: '+tab);
}
console.log('Startup readiness: online/offline/unknown, retained, exact boundaries, flap, stale, restart, policy, queue and dry-run passed.');
