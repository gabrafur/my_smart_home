import assert from 'node:assert/strict';
import {withHostTimingSource} from './host-observation-timing.mjs';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {projectObservation, safeMetadata, SERVICES, UNITS, METRICS} from './read-host-observation.mjs';
import {POLICY, installHostObserver} from './install-host-observer-flow.mjs';

const flows=JSON.parse(fs.readFileSync(process.env.HOST_OBSERVER_TEST_FLOW??new URL('../flows.json',import.meta.url),'utf8'));
const byId=new Map(flows.map(n=>[n.id,n]));
const source=file=>withHostTimingSource(fs.readFileSync(new URL(`functions/host-observer-${file}.js`,import.meta.url),'utf8').trimEnd());
for(const name of ['normalize','facts','lifecycle','test-build','policy','read-completion','timing','timing-policy']){
  const id={facts:'facts',lifecycle:'lifecycle','test-build':'test_build',normalize:'normalize',policy:'policy_store','read-completion':'read_complete',timing:'timing_account','timing-policy':'timing_policy_store'}[name];
  assert.equal(byId.get(`host_obs_${id}`)?.func,source(name));
}
const supportedSwitchRules=new Set(['eq','lte','gte','true','null','else','regex']);
for(const n of flows.filter(n=>n.z==='host_observer_tab'&&n.type==='switch'))for(const rule of n.rules)assert.ok(supportedSwitchRules.has(rule.t),`unsupported Node-RED switch operator ${rule.t}`);
assert.equal(byId.get('host_obs_read').command,'/usr/local/bin/node --max-old-space-size=32 /data/tools/read-host-observation.mjs');
assert.equal(byId.get('host_obs_read').addpay,'');
assert.equal(byId.get('host_obs_read').timer,'3');
assert.equal(byId.get('host_obs_tick').repeat,'2');
assert.ok(byId.get('global_observer_alert_to_dispatch_in').links.includes('host_obs_alert_out'));
assert.deepEqual(installHostObserver(installHostObserver(flows)),installHostObserver(flows),'host generator idempotent,including routed nodes');
const disabled=structuredClone(flows);disabled.find(n=>n.id==='host_observer_tab').disabled=true;assert.equal(installHostObserver(disabled).find(n=>n.id==='host_observer_tab').disabled,true,'regeneration preserves disabled tab');
const producer=fs.readFileSync(new URL('../../scripts/host-observation/observer.py',import.meta.url),'utf8');
for(const name of [...SERVICES,...UNITS.filter(n=>!['procmon','mcp_collection','events','ha_notices','external_heartbeat','host_observation'].includes(n))])assert.ok(producer.includes(`'${name}'`));

const get=(obj,path)=>path.split('.').reduce((v,k)=>v?.[k],obj);
const set=(obj,path,value)=>{const p=path.split('.');let cursor=obj;for(const key of p.slice(0,-1))cursor=cursor[key]??={};cursor[p.at(-1)]=value;};
function memory(){const maps={default:new Map(),persistent:new Map(),memoryOnly:new Map()};return {maps,get(k,s='default'){return maps[s].get(k);},set(k,v,s='default'){maps[s].set(k,structuredClone(v));}};}
function harness(){
 const contexts=new Map();const dry=[], effects=[],decisions=[],errors=[];
 const context=z=>{if(!contexts.has(z))contexts.set(z,memory());return contexts.get(z);};
 const run=(start,msg)=>{
  const queue=[[start,msg]];let visits=0;
  while(queue.length){assert.ok(++visits<10000,'bounded graph replay');const [id,input]=queue.shift();const n=byId.get(id);assert.ok(n,`node exists ${id}`);
   const send=(targets,value)=>{for(const target of targets??[])queue.push([target,structuredClone(value)]);};
   if(n.type==='function'){
    if(id==='global_observer_dispatch_guard')decisions.push(structuredClone(input));
    if(id==='global_observer_dry_run_terminal')dry.push(structuredClone(input));
    const result=new Function('msg','flow','node','global','timingClock',n.func)(input,context(n.z),{status(){},log(){},warn(){},error(v){errors.push(v);}},{get(){}},{performance:{timeOrigin:1,now:()=>0}});
    if(result){const outputs=Array.isArray(result)?result:[result];for(const [i,value]of outputs.entries())for(const message of Array.isArray(value)?value:[value])if(message)send(n.wires?.[i],message);}
   }else if(n.type==='change'){
    for(const rule of n.rules){assert.equal(rule.pt,'msg');let value=rule.tot==='json'?JSON.parse(rule.to):rule.tot==='bool'?rule.to==='true':rule.tot==='num'?Number(rule.to):rule.to;set(input,rule.p,value);}send(n.wires[0],input);
   }else if(n.type==='switch'){
    const value=get(input,n.property);let matched=false;
    for(const [i,rule]of n.rules.entries()){
     const target=rule.vt==='msg'?get(input,rule.v):rule.vt==='num'?Number(rule.v):rule.v;
     const match=rule.t==='else'&&!matched||rule.t==='true'&&value===true||rule.t==='null'&&value==null||rule.t==='eq'&&value===target||rule.t==='regex'&&new RegExp(rule.v).test(value)||rule.t==='lte'&&value<=target||rule.t==='gte'&&value>=target;
     if(match){matched=true;send(n.wires[i],input);if(n.checkall==='false')break;}
    }
   }else if(n.type==='link out')send(n.links,input);
   else if(n.type==='link in')send(n.wires[0],input);
   else {effects.push(n.type);throw new Error(`side effect reached ${id}/${n.type}`);}
  }
 };
 run('host_obs_policy_config',{payload:null});
 run('host_obs_timing_policy_config',{payload:null});
 return {run,context,dry,effects,decisions,errors,scenario(name){run('host_obs_test_build',{_host_observer_test:true,payload:name});}};
}
const h=harness();h.scenario('reset');h.scenario('healthy');h.scenario('failure');assert.equal(h.dry.length,0);
h.scenario('confirm');assert.equal(h.dry.length,1);assert.equal(h.dry[0].payload.observer_kind,'host_failure');
h.scenario('confirm');assert.equal(h.dry.length,1,'same failure not resent');
h.scenario('healthy');assert.equal(h.dry.length,2);assert.equal(h.dry[1].payload.persistent_notification_operation,'dismiss');
assert.equal(h.context('host_observer_tab').get('host_observer_incidents_v1','persistent'),undefined,'test never writes production incidents');
assert.equal(h.context('host_observer_tab').get('host_observer_cursor_v1','persistent'),undefined);
assert.deepEqual(h.effects,[]);
const productionPolicy=h.context('host_observer_tab').get('host_observer_policy_v1','persistent');
h.run('host_obs_policy_store',{payload:{...POLICY,cpu_busy_percent:Infinity}});
assert.deepEqual(h.context('host_observer_tab').get('host_observer_policy_v1','persistent'),productionPolicy,'invalid policy preserves prior');

const resource=harness();resource.scenario('healthy');resource.scenario('resource_high');resource.scenario('confirm');
assert.equal(resource.dry.length,1);assert.equal(resource.dry[0].payload.host_role,'cpu');
resource.scenario('confirm');assert.equal(resource.dry.length,1);
resource.scenario('healthy');assert.equal(resource.dry.length,2);

// Correlate the actual shared terminal, including dedupe and recovery, without
// writing production context or accepting an interleaved/manual run as ours.
const traced=harness(), runId='c'.repeat(32);
const step=(name,id=runId)=>traced.run('host_obs_test_build',{
 _host_observer_test:true,_host_test_run_id:id,payload:name});
const receipt=()=>traced.context('global_flow_observer_tab').get('global_flow_observer_last_dry_run_v1');
for(const name of ['reset','healthy','failure','confirm'])step(name);
assert.equal(receipt().run_id,runId);
assert.equal(receipt().source_flow_id,'host_observer_tab');
assert.equal(receipt().receipt_sequence,1);
assert.equal(receipt().observer_kind,'host_failure');
assert.equal(receipt().simulated,true);assert.equal(receipt().dispatched,false);
const before=structuredClone(receipt());step('confirm');assert.deepEqual(receipt(),before,'same incident is not dispatched again');
const fixture=structuredClone(traced.context('host_observer_tab').get('host_observer_fixture_v1__test'));
for(const id of ['d'.repeat(32),'invalid',null])step('healthy',id);
traced.run('host_obs_test_build',{_host_observer_test:true,payload:'healthy'});
assert.deepEqual(traced.context('host_observer_tab').get('host_observer_fixture_v1__test'),fixture,'other runs cannot advance fixture');
step('healthy');assert.equal(receipt().receipt_sequence,2);assert.equal(receipt().observer_kind,'host_recovery');
assert.equal(traced.context('host_observer_tab').get('host_observer_incidents_v1','persistent'),undefined);
assert.equal(traced.context('host_observer_tab').get('host_observer_cursor_v1','persistent'),undefined);
assert.equal(traced.effects.length,0);assert.equal(traced.errors.length,0);
for(const input of [
 {payload:{observer_kind:'host_failure'}},
 {_global_observer_test:true,_observer_delivery_test:true,payload:{test_mode:true}},
 {_global_observer_test:true,_observer_test_receipt:{run_id:'bad',source_flow_id:'host_observer_tab'}},
 {_global_observer_test:true,_observer_test_receipt:{run_id:runId,source_flow_id:'other'}},
 {_global_observer_test:true,_observer_test_receipt:{run_id:runId,source_flow_id:'host_observer_tab',extra:true}},
]){
 traced.run('global_observer_dry_run_terminal',input);
 assert.equal(receipt().receipt_sequence,2,'invalid or production input creates no dry-run receipt');
}
traced.scenario('reset');assert.equal(traced.context('host_observer_tab').get('host_observer_fixture_v1__test'),undefined);

function frame(at=1000000,sequence=0,action='started'){
 const iso=new Date(at).toISOString();return {schema_version:1,source:'fixed_readonly_host_observer',observed_at:iso,instance_id:'a'.repeat(64),boot_id_sha256:'b'.repeat(64),sequence,evicted_event_records:0,
  sources:{docker:{state:'connected',collection_error:null},systemd:{state:'connected',collection_error:null}},
  events:sequence?[{id:sequence.toString(16).padStart(64,'0'),source:'docker',service:'nodered',action,sequence,occurred_at:iso,observed_at:iso,source_to_observer_ms:0}]:[],
  resources:{observed_at:iso,collection_errors:[],data:Object.fromEntries(METRICS.map(k=>[k,k==='memory_available_bytes'?4096*1048576:k==='memory_total_bytes'?8192*1048576:k==='oom_kill_count'?0:10]))}};
}
function replay(h,report,now,extra={}){h.run('host_obs_normalize',{_host_observer_test:true,_host_test_now:now,payload:{schema_version:1,collection_error:null,report},...extra});}
const strict=harness();replay(strict,frame(),1000000);replay(strict,frame(1001000,1,'die'),1001000);replay(strict,frame(1007000,1,'die'),1007000);assert.equal(strict.dry.length,1);
replay(strict,frame(1008000,2,'start'),1008000);assert.equal(strict.dry.length,1,'container start cannot dismiss application-readiness incident');
replay(strict,frame(1009000,3,'health_status: healthy'),1009000);assert.equal(strict.dry.length,2);
const interrupted=harness();replay(interrupted,frame(),1000000);
replay(interrupted,frame(1001000,1,'die'),1001000);
let disconnected=frame(1002000,1,'die');disconnected.sources.docker={state:'unknown',collection_error:'stream_unavailable_or_invalid'};
replay(interrupted,disconnected,1002000);replay(interrupted,frame(1008000,1,'die'),1008000);
assert.equal(interrupted.dry.length,0,'reconnect without a new transition cannot confirm an old physical failure');
// Unknown evidence interrupts confirmation, but cannot replace the start of an
// incident that has already produced a notification intent.
const notifiedGap=harness();replay(notifiedGap,frame(),1000000);
replay(notifiedGap,frame(1001000,1,'die'),1001000);
replay(notifiedGap,frame(1007000,1,'die'),1007000);
const incidentOf=h=>h.context('host_observer_tab').get('host_observer_incidents_v1__test').incidents.native_docker_nodered;
const notifiedBefore=structuredClone(incidentOf(notifiedGap));
const unavailable=frame(1008000,1,'die');unavailable.sources.docker={state:'unknown',collection_error:'stream_unavailable_or_invalid'};
replay(notifiedGap,unavailable,1008000);
assert.equal(incidentOf(notifiedGap).current_evidence,'unknown');
replay(notifiedGap,frame(1009000,2,'die'),1009000);
assert.equal(incidentOf(notifiedGap).first_seen_at,notifiedBefore.first_seen_at,'notified incident keeps its original chronology after unknown');
assert.equal(incidentOf(notifiedGap).notified_at,notifiedBefore.notified_at,'unknown does not clear notification dedupe');
assert.equal(incidentOf(notifiedGap).source_first_observed_at,notifiedBefore.source_first_observed_at,'preserve original source evidence');
assert.ok(incidentOf(notifiedGap).first_seen_at<=incidentOf(notifiedGap).notified_at);
assert.equal(notifiedGap.dry.length,1,'returning failure is not another notification');
replay(notifiedGap,frame(1015000,3,'health_status: healthy'),1015000);
assert.equal(notifiedGap.dry.length,2);assert.equal(notifiedGap.dry[1].payload.observer_kind,'host_recovery');
assert.equal(incidentOf(notifiedGap),undefined,'only observed recovery closes the incident');
assert.equal(notifiedGap.effects.length,0);
const unconfirmedGap=harness();replay(unconfirmedGap,frame(),1000000);
replay(unconfirmedGap,frame(1001000,1,'die'),1001000);
replay(unconfirmedGap,unavailable,1008000);
replay(unconfirmedGap,frame(1009000,2,'die'),1009000);
assert.equal(incidentOf(unconfirmedGap).first_seen_at,1009000,'unnotified incident starts confirmation again');
replay(unconfirmedGap,frame(1011000,2,'die'),1011000);assert.equal(unconfirmedGap.dry.length,0);
replay(unconfirmedGap,frame(1015000,2,'die'),1015000);assert.equal(unconfirmedGap.dry.length,1);
// A pre-fix chronology is retained as uncertain history, without a recovery
// alert or reclassifying its repeated cursor event as a new failure.
const legacyManual=harness();legacyManual.scenario('reset');legacyManual.scenario('healthy');legacyManual.scenario('legacy');
const legacyManualState=()=>legacyManual.context('host_observer_tab').get('host_observer_incidents_v1__test');
assert.equal(legacyManualState().incidents['native_docker_ai-bridge'],undefined);
assert.equal(legacyManualState().legacy_history_v1.records.length,1);
assert.equal(legacyManualState().legacy_history_v1.records[0].reason,'legacy_notified_before_first_seen');
assert.equal(legacyManual.dry.length,0,'quarantine is not a failure or recovery notification');
assert.equal(legacyManual.effects.length,0);
assert.equal(legacyManual.context('host_observer_tab').get('host_observer_incidents_v1','persistent'),undefined);
legacyManual.scenario('legacy');assert.equal(legacyManualState().legacy_history_v1.records.length,1,'repeat does not duplicate history');
const legacyOriginal={kind:'native',first_seen_at:995000,last_seen_at:997000,notified_at:994000,
 current_evidence:'failed',source_first_observed_at:new Date(995000).toISOString(),source_time_kind:'producer_occurrence',sample_count:0,last_sample_at:null};
const legacy=harness();legacy.context('host_observer_tab').set('host_observer_incidents_v1__test',
 {version:1,incidents:{native_docker_nodered:structuredClone(legacyOriginal)}});
replay(legacy,frame(997000,1,'die'),1000000);
const legacyState=()=>legacy.context('host_observer_tab').get('host_observer_incidents_v1__test');
assert.deepEqual(legacyState().legacy_history_v1.records[0].original,legacyOriginal,'original dates and evidence retained exactly');
assert.equal(legacyState().incidents.native_docker_nodered,undefined);
replay(legacy,frame(997000,1,'die'),1001000);
assert.equal(legacy.dry.length,0,'the old cached failure cannot emit again');
const restartedLegacy=harness();restartedLegacy.context('host_observer_tab').set('host_observer_incidents_v1__test',structuredClone(legacyState()));
replay(restartedLegacy,frame(997000,1,'die'),1001000);
assert.equal(restartedLegacy.dry.length,0);assert.equal(restartedLegacy.context('host_observer_tab').get('host_observer_incidents_v1__test').legacy_history_v1.records.length,1);
replay(legacy,frame(1002000,2,'die'),1002000);replay(legacy,frame(1008000,2,'die'),1008000);
assert.equal(legacy.dry.length,1,'a genuinely later failure still confirms and notifies');
assert.equal(legacy.dry[0].payload.observer_kind,'host_failure');
assert.equal(legacyState().legacy_history_v1.records.length,1,'new incident does not replace original history');
for(const [role,row]of [
 ['native_docker_private_fixture',legacyOriginal],
 ['native_docker_nodered',{...legacyOriginal,private:'PRIVATE_SENTINEL'}],
 ['native_docker_nodered',{...legacyOriginal,last_seen_at:2000000}],
 ['native_docker_nodered',{...legacyOriginal,notified_at:996000}],
]){
 const rejected=harness();rejected.context('host_observer_tab').set('host_observer_incidents_v1__test',{version:1,incidents:{[role]:row}});
 replay(rejected,frame(),1000000);
 const ledger=rejected.context('host_observer_tab').get('host_observer_incidents_v1__test');
 assert.deepEqual(ledger.incidents[role],row,'unknown schema, future clock or valid current incident is not quarantined');
 assert.equal(ledger.legacy_history_v1,undefined);assert.equal(rejected.dry.length,0);assert.equal(rejected.effects.length,0);
}
const rc=harness();rc.run('host_obs_read_complete',{payload:{code:0}});assert.equal(rc.dry.length,0);
const code=new Function('msg',source('read-completion'));assert.equal(code({payload:{code:0}}),null);assert.equal(code({payload:{code:1}}).payload.report,null);assert.equal(code({payload:{signal:'SIGTERM'}}).payload.collection_error,'source_invalid_or_unavailable');
const malformed=harness();for(const now of [1000000,1021000])replay(malformed,null,now);
assert.equal(malformed.dry.length,1);assert.equal(malformed.dry[0].payload.host_role,'report');assert.ok(!JSON.stringify(malformed.decisions).includes('PRIVATE_SENTINEL'));
const stale=harness();replay(stale,frame(),1040000);replay(stale,frame(),1061000);assert.equal(stale.dry.length,1,'stale means observation failure');
const oneSample=harness();let value=frame();value.resources.data.cpu_busy_percent=96;replay(oneSample,value,1000000);
value={...value,observed_at:new Date(1021000).toISOString()};replay(oneSample,value,1021000);assert.equal(oneSample.dry.length,0,'same old resource sample is not two observations');
value.resources={...value.resources,observed_at:new Date(1021000).toISOString()};replay(oneSample,value,1021000);assert.equal(oneSample.dry.length,1);
const noRecovery=structuredClone(value);noRecovery.observed_at=new Date(1022000).toISOString();noRecovery.resources={...noRecovery.resources,observed_at:noRecovery.observed_at,data:{...noRecovery.resources.data,cpu_busy_percent:null}};replay(oneSample,noRecovery,1022000);assert.equal(oneSample.dry.length,1,'missing CPU is not recovery');
const oom=harness();replay(oom,frame(),1000000);value=frame(1001000);value.resources.data.oom_kill_count=1;replay(oom,value,1001000);value=frame(1007000);value.resources.data.oom_kill_count=1;replay(oom,value,1007000);assert.equal(oom.dry.length,1);assert.equal(oom.dry[0].payload.host_role,'host_oom');

const clean=frame();clean.events=[];clean.PRIVATE_SENTINEL='PRIVATE_SENTINEL';clean.resources.PRIVATE_SENTINEL='PRIVATE_SENTINEL';
assert.ok(!JSON.stringify(projectObservation(clean)).includes('PRIVATE_SENTINEL'));
for(const mutate of [v=>v.observed_at=null,v=>v.observed_at='2026-02-30T01:00:00Z',v=>v.resources.observed_at='2026-01-01',v=>v.resources.data.cpu_busy_percent=101,v=>v.sources.docker.state='ready',v=>v.sequence=-1]){
 const value=frame();mutate(value);assert.throws(()=>projectObservation(value));
}
let event=frame(1000000,1,'die');assert.equal(projectObservation(event).events.length,1);
for(const mutate of [v=>v.events[0].service='private',v=>v.events[0].source_to_observer_ms=5000,v=>v.events.push({...v.events[0]})]){const value=structuredClone(event);mutate(value);assert.throws(()=>projectObservation(value));}
const meta={uid:0,gid:0,mode:0o100644,nlink:1,size:1,isFile:()=>true,isDirectory:()=>false};
assert.equal(safeMetadata(meta),true);for(const changes of [{uid:1000},{mode:0o104644},{mode:0o100666},{nlink:2},{size:65537},{isFile:()=>false}])assert.equal(safeMetadata({...meta,...changes}),false);
const refused=spawnSync(process.execPath,[new URL('./read-host-observation.mjs',import.meta.url).pathname,'free-argument'],{encoding:'utf8'});assert.equal(refused.status,64);assert.equal(JSON.parse(refused.stdout).collection_error,'arguments_refused');
console.log('Host observer: closed reader,visual thresholds,cursors,unknown states,failures,recovery,dedupe and full dry-run replay passed.');

const measured = harness();
measured.scenario('reset'); measured.scenario('healthy'); measured.scenario('failure'); measured.scenario('confirm');
const timingState = measured.context('host_observer_tab').get('host_observer_timing_v1__test');
assert.equal(timingState.state, 'observed');
assert.ok(timingState.sources.resources.observed > 0);
assert.ok(timingState.sources.systemd.observed > 0);
const limitsBefore = measured.context('host_observer_tab').get('host_observer_timing_policy_v1','persistent');
measured.run('host_obs_timing_policy_store',{payload:{event_latency_ms:1,resource_latency_ms:60000}});
assert.deepEqual(measured.context('host_observer_tab').get('host_observer_timing_policy_v1','persistent'),limitsBefore);
assert.equal(measured.context('host_observer_tab').get('host_observer_timing_v1','persistent'),undefined);
measured.scenario('reset');
assert.equal(measured.context('host_observer_tab').get('host_observer_timing_v1__test'),undefined);
assert.equal(measured.context('host_observer_tab').get('host_observer_timing_runtime_v1__test','memoryOnly'),undefined);
console.log('Passive accounting traverses the complete manual graph, preserves production separation and resets only test state.');
