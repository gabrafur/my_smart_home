import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {installMqttNative,TAB,POLICY} from './install-mqtt-native-observer-flow.mjs';

const flows=JSON.parse(fs.readFileSync(process.env.MQTT_NATIVE_TEST_FLOW ?? new URL('../flows.json',import.meta.url)));
const byId=new Map(flows.map(n=>[n.id,n]));
const get=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
const set=(o,p,v)=>{const keys=p.split('.');for(const k of keys.slice(0,-1))o=o[k]??={};o[keys.at(-1)]=structuredClone(v);};
function memory(){const maps={default:new Map(),persistent:new Map(),memoryOnly:new Map()};return {maps,get(k,s='default'){return maps[s].get(k);},set(k,v,s='default'){maps[s].set(k,structuredClone(v));}};}
function harness(){
 const contexts=new Map(),visits=[],dry=[],shared=[],effects=[],errors=[];
 const context=z=>{if(!contexts.has(z))contexts.set(z,memory());return contexts.get(z);};
 function run(start,msg){
  const queue=[[start,structuredClone(msg)]];let steps=0;
  while(queue.length){
   assert.ok(++steps<1000,'bounded graph replay');
   const [id,input]=queue.shift(),n=byId.get(id);assert.ok(n,`node exists ${id}`);visits.push(id);
   const send=(ids,value)=>{for(const target of ids??[])queue.push([target,structuredClone(value)]);};
   if(n.type==='function'){
    if(id==='mq_native_dry_run_terminal')dry.push(structuredClone(input));
    if(id==='global_observer_dry_run_terminal')shared.push(structuredClone(input));
    const result=new Function('msg','flow','node','global','timingClock',n.func)(input,context(n.z),{status(){},log(){},warn(){},error(e){errors.push(e);}},{get(){}},{performance:{timeOrigin:1,now:()=>0}});
    if(result){const outputs=Array.isArray(result)?result:[result];for(const [i,value]of outputs.entries())for(const m of Array.isArray(value)?value:[value])if(m)send(n.wires?.[i],m);}
   }else if(n.type==='change'){
    for(const r of n.rules){assert.equal(r.pt,'msg');assert.equal(r.t,'set');const v=r.tot==='msg'?get(input,r.to):r.tot==='json'?JSON.parse(r.to):r.tot==='bool'?r.to==='true':r.tot==='num'?Number(r.to):r.to;set(input,r.p,v);}send(n.wires[0],input);
   }else if(n.type==='switch'){
    const value=get(input,n.property);let matched=false;
    for(const [i,r]of n.rules.entries()){
     const target=r.vt==='msg'?get(input,r.v):r.vt==='num'?Number(r.v):r.v;
     const match=r.t==='else'&&!matched||r.t==='true'&&value===true||r.t==='false'&&value===false||r.t==='null'&&value==null||r.t==='eq'&&value===target||r.t==='lte'&&value<=target;
     if(match){matched=true;send(n.wires[i],input);if(n.checkall==='false')break;}
    }
   }else if(n.type==='link out')send(n.links,input);
   else if(n.type==='link in')send(n.wires[0],input);
   else if(n.type==='debug'){}
   else {effects.push(n.type);throw new Error(`external effect reached ${id}/${n.type}`);}
  }
 }
 run('mq_native_policy_config',{_mqtt_defaults:true});
 return {run,context,visits,dry,shared,effects,errors,
  scenario(name){const n=byId.get('mq_native_test_'+name),m={};for(const p of n.props)set(m,p.p,p.vt==='bool'?p.v==='true':p.v);for(const id of n.wires[0])run(id,m);},
  receipt(){return context(TAB).get('mqtt_native_last_dry_run_v1__test','memoryOnly');}};
}

test('generated canvas is idempotent, disabled by default, fixed commands and globally observable',()=>{
 const regenerated=installMqttNative(structuredClone(flows));
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const previous=new Map(flows.map(n=>[n.id,n]));
 const changed=regenerated.filter(n=>hash(n)!==hash(previous.get(n.id)??null)).map(n=>n.id);
 assert.deepEqual(changed,[],'generator must preserve every existing node');
 assert.equal(hash(regenerated.map(n=>n.id)),hash(flows.map(n=>n.id)),'generator preserves node order');
 assert.equal(new Set(flows.map(n=>n.id)).size,flows.length);
 assert.equal(POLICY.enabled,false);
 assert.deepEqual(JSON.parse(byId.get('mq_native_policy_config').rules[0].to),POLICY);
 assert.equal(byId.get('mq_native_prepare').addpay,'');
 assert.equal(byId.get('mq_native_commit').addpay,'payload');
 for(const id of ['prepare','commit']){
  assert.equal(byId.get('mq_native_'+id).command,'/bin/sh /data/tools/mqtt-source-observation/consumer-command.sh '+id);
  assert.equal(byId.get('mq_native_'+id).timer,'3');
 }
 assert.ok(byId.get('global_observer_alert_to_dispatch_in').links.includes('mq_native_test_global_out'));
 assert.ok(flows.some(n=>n.z===TAB&&n.type==='catch'));
 assert.ok(flows.some(n=>n.z===TAB&&n.type==='status'));
 assert.equal(flows.filter(n=>n.z===TAB&&n.type==='switch'&&n.rules.some(r=>r.v==='_mqtt_policy.event_latency_ms')).length,2);
});

test('complete graph classifies nominal, duplicate, over-limit, clock uncertainty, missing events and silence',()=>{
 const h=harness();h.scenario('reset');assert.equal(h.dry.length,0);
 for(const [name,classification,operation]of [
  ['within','within_contract','commit'],['duplicate','within_contract','skip_duplicate'],
  ['over','over_contract','commit'],['unknown','unknown','commit'],['missing','unknown','commit'],
  ['no_events','no_events','commit'],['unavailable','unknown','noop'],['busy','busy','noop'],
  ['malformed','unknown','noop'],['disabled','disabled','noop'],['reader_denied','disabled','noop'],['reader_clock','unknown','noop'],['reader_future','unknown','noop'],['reader_stale','unknown','noop'],['reader_missing','unknown','noop']]){
  const before=h.shared.length;h.scenario(name);
  assert.equal(h.receipt().classification,classification,name);
  assert.equal(h.receipt().operation,operation,name);
  assert.equal(h.shared.length,before+1,name+' reaches shared dry run');
  assert.equal(h.receipt().simulated,true);assert.equal(h.receipt().dispatched,false);
 }
 for(const id of ['mq_native_normalize','mq_native_threshold','mq_native_intent','mq_native_test_gate','global_observer_dry_run_terminal'])assert.ok(h.visits.includes(id));
 assert.deepEqual(h.effects,[]);assert.deepEqual(h.errors,[]);
 assert.equal(h.context(TAB).get('mqtt_native_observer_v1','persistent'),undefined);
 assert.deepEqual(h.context(TAB).get('mqtt_native_policy_v1','persistent'),POLICY);
 h.scenario('reset');assert.equal(h.receipt(),undefined);
});

test('in-flight reading is serialized and an unrelated busy message cannot release its lock',()=>{
 const h=harness();h.context(TAB).set('mqtt_native_inflight_v1__test',true,'memoryOnly');h.scenario('within');
 assert.equal(h.receipt().classification,'busy');
 assert.equal(h.context(TAB).get('mqtt_native_inflight_v1__test','memoryOnly'),true);
 assert.ok(!h.visits.includes('mq_native_synthetic'));
});

test('invalid policies and bootstrap retain last valid values; test and production namespaces differ',()=>{
 const h=harness(),p={enabled:true,event_latency_ms:22000};
 h.run('mq_native_policy_store',{payload:p});h.run('mq_native_policy_config',{_mqtt_defaults:true});
 for(const bad of [{enabled:true,event_latency_ms:999},{enabled:true,event_latency_ms:60001},{...p,extra:true},{enabled:'true',event_latency_ms:22000}])h.run('mq_native_policy_store',{payload:bad});
 assert.deepEqual(h.context(TAB).get('mqtt_native_policy_v1','persistent'),p);
 h.scenario('within');assert.equal(h.receipt().classification,'within_contract');
 assert.deepEqual(h.context(TAB).get('mqtt_native_policy_v1','persistent'),p);
});

test('malformed counts and forged timing cannot cross protocol validation or request a commit',()=>{
 for(const mutate of [
  v=>v.received_counts.stats.publish_in.expected='2',
  v=>v.received_counts.faults.extra='0',
  v=>v.received_counts.extra='0',
  v=>v.receipt_facts[0].by_kind.publish_in.source_to_consumer_upper_ms=0,
  v=>v.receipt_facts[0].by_kind.publish_in.source_to_consumer_upper_ns='18446744073709551616',
  v=>v.proposal_sha='; external-command',
 ]){
  const h=harness();h.scenario('within');const v=structuredClone(h.context(TAB).get('mqtt_native_fixture_v1__test','memoryOnly'));mutate(v);
  h.run('mq_native_normalize',{test_mode:true,_mqtt_key:'mqtt_native_observer_v1__test',_mqtt_store:'memoryOnly',_mqtt_policy:POLICY,payload:v});
  assert.equal(h.receipt().classification,'unknown');assert.equal(h.receipt().operation,'noop');assert.deepEqual(h.effects,[]);
 }
});

test('production with the default disabled policy executes no source reader or external effect',()=>{
 const h=harness();h.run('mq_native_read_policy',{});
 assert.ok(!h.visits.includes('mq_native_prepare'));assert.ok(!h.visits.includes('mq_native_commit'));
 assert.equal(h.context(TAB).get('mqtt_native_observer_v1','persistent').classification,'disabled');
 assert.deepEqual(h.effects,[]);
});

test('unknown source retains historical missing counts without claiming a zero-event observation',()=>{
 const h=harness();h.scenario('missing');h.scenario('unavailable');
 const snapshot=h.context(TAB).get('mqtt_native_observer_v1__test','memoryOnly');
 assert.equal(snapshot.classification,'unknown');assert.equal(snapshot.missing_total,'1');
 assert.equal(snapshot.observed_total,null);assert.equal(snapshot.timing_unknown_total,null);
});

test('valid historical gaps, source faults, epoch tails and unknown times remain canonical unknown',()=>{
 for(const mutate of [
  v=>v.received_counts.report_gaps='1',
  v=>v.received_counts.unknown_epoch_tails='1',
  v=>v.received_counts.source_clock_faults='1',
  v=>v.received_counts.ack_clock_conflicts='1',
  v=>v.received_counts.faults.reader_restart='1',
  v=>{const r=v.received_counts.stats.publish_in;r.expected='2';r.observed='2';r.timing_unknown='1';},
 ]){
  const h=harness();h.scenario('within');const v=structuredClone(h.context(TAB).get('mqtt_native_fixture_v1__test','memoryOnly'));mutate(v);
  h.run('mq_native_normalize',{test_mode:true,_mqtt_key:'mqtt_native_observer_v1__test',_mqtt_store:'memoryOnly',_mqtt_policy:POLICY,payload:v});
  assert.equal(h.receipt().classification,'unknown');assert.equal(h.receipt().operation,'skip_duplicate');
 }
});


test('a late completion cannot release another read or publish a second old diagnostic',()=>{
 const h=harness(),key='mqtt_native_inflight_v1__test';
 h.context(TAB).set(key,{token:'newer'},'memoryOnly');
 const old={test_mode:true,_mqtt_owns_flight:true,_mqtt_flight_key:key,_mqtt_flight_token:'older',payload:{code:1}};
 h.run('mq_native_release',old);h.run('mq_native_read_complete',old);h.run('mq_native_commit_complete',old);
 assert.deepEqual(h.context(TAB).get(key,'memoryOnly'),{token:'newer'});assert.equal(h.dry.length,0);
});

test('reader gate uses the same contract and never ACKs stale or closed authorization',()=>{
 for(const [ns,ms,expected]of [['10000000000',10000,'commit'],['10000000001',10001,'noop']]){
  const h=harness();h.scenario('within');const v=structuredClone(h.context(TAB).get('mqtt_native_fixture_v1__test','memoryOnly'));
  v.proposal_sha='f'.repeat(64);v.reader_facts.status_age_ns=ns;v.reader_facts.status_age_ms=ms;
  h.run('mq_native_normalize',{test_mode:true,_mqtt_key:'mqtt_native_observer_v1__test',_mqtt_store:'memoryOnly',_mqtt_policy:POLICY,payload:v});
  assert.equal(h.receipt().operation,expected);
 }
});

test('a current reader fault is visible before its next immutable handoff packet',()=>{
 const h=harness();h.scenario('within');const v=structuredClone(h.context(TAB).get('mqtt_native_fixture_v1__test','memoryOnly'));
 v.proposal_sha='f'.repeat(64);v.reader_facts.faults.source_identity_lost='1';
 h.run('mq_native_normalize',{test_mode:true,_mqtt_key:'mqtt_native_observer_v1__test',_mqtt_store:'memoryOnly',_mqtt_policy:POLICY,payload:v});
 assert.equal(h.receipt().classification,'unknown');assert.equal(h.receipt().operation,'commit');
});
