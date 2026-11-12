import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {validateNetwork,captureNetwork,snapshotEligible,requestValid,tick,adapterRestoreScript} from './zigbee-coordinator-recovery.mjs';
const now=1800000000000;
function fixture() {
 const config={advanced:{network_key:Array(16).fill(1),ext_pan_id:Array(8).fill(2),pan_id:123,channel:26}};
 const backup={metadata:{format:'zigpy/open-coordinator-backup',version:1},coordinator_ieee:'0000000000000001',pan_id:'7b',extended_pan_id:'02'.repeat(8),channel:26,channel_mask:[11],network_key:{key:'01'.repeat(16),frame_counter:100},devices:[{ieee_address:'0000000000000002'}]};
 const database=[{type:'Coordinator',ieeeAddr:'0x0000000000000001'},{type:'Router',ieeeAddr:'0x0000000000000002',lastSeen:now-1000,interviewCompleted:true}].map(JSON.stringify).join('\n');
 return {config,backup,database};
}
test('channel migration normalizes mask while preserving identity, keys and counters',()=>{
 const f=fixture(),r=validateNetwork(f.config,f.backup,f.database);assert.deepEqual(r.backup.channel_mask,[26]);assert.deepEqual(r.backup.network_key,f.backup.network_key);assert.equal(f.backup.channel_mask[0],11);
 for(const field of ['channel','pan_id','extended_pan_id','coordinator_ieee']){const b=structuredClone(f.backup);b[field]=field==='channel'?25:'wrong';assert.throws(()=>validateNetwork(f.config,b,f.database));}
});
test('empty, incomplete and mismatched backups cannot replace last good',()=>{
 const f=fixture();assert.throws(()=>validateNetwork(f.config,f.backup,JSON.stringify({type:'Coordinator',ieeeAddr:'0x0000000000000001'})));
 const b=structuredClone(f.backup);b.devices=[];assert.throws(()=>validateNetwork(f.config,b,f.database));
 assert.throws(()=>validateNetwork(f.config,f.backup,f.database.replace('"interviewCompleted":true','"interviewCompleted":false')));
 const c=validateNetwork(f.config,f.backup,f.database),facts={running:true,uptime_s:500,invalid_param_count:0,last_seen_age_s:1};
 assert.equal(snapshotEligible(c,c,facts),true);
 for(const bad of [{last_seen_age_s:null},{invalid_param_count:1},{uptime_s:1},{running:false},{last_seen_age_s:301}])assert.equal(snapshotEligible(c,c,{...facts,...bad}),false);
 assert.equal(snapshotEligible(c,{...c,devices:2},facts),false);assert.equal(snapshotEligible(c,{...c,identity:'different'},facts),false);
});
test('requests require fresh exact observations; duplicates never replay',()=>{
 const r={id:'a'.repeat(32),action:'restore',facts_id:'b',requested_at:now},f={id:'b'};
 assert.equal(requestValid(r,f,now,{receipts:[]}),true);
 for(const bad of [{action:'shell'},{facts_id:'other'},{requested_at:now+1},{requested_at:now-90001},{extra:1}])assert.equal(requestValid({...r,...bad},f,now,{receipts:[]}),false);
 assert.equal(requestValid(r,f,now,{receipts:[{id:r.id}]}),false);
});
test('native adapter snapshots and restores missing database without actuators; uncertain intent blocks replay',()=>{
 const f=fixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-guard-')),data=path.join(root,'zigbee2mqtt'),priv=path.join(root,'private'),pub=path.join(root,'nodered','zigbee-recovery');
 fs.mkdirSync(data,{recursive:true});
 fs.writeFileSync(path.join(data,'configuration.yaml'),JSON.stringify(f.config));fs.writeFileSync(path.join(data,'coordinator_backup.json'),JSON.stringify(f.backup));fs.writeFileSync(path.join(data,'database.db'),f.database);
 let temporaryRunning=false;const calls=[],runtime={now:()=>now,docker:a=>{calls.push(a);if(a[0]==='ps')return temporaryRunning?'zigbee-firmware-network-restore':'';return a[0]==='inspect'?(a.at(-1)==='{{.Image}}'?'sha256:'+'1'.repeat(64):JSON.stringify({Running:true,StartedAt:new Date(now-600000).toISOString()})):''},logs:()=>({status:0,stdout:'',stderr:''})};
 const run=()=>tick(root,priv,runtime);
 const request=(facts,action,id)=>fs.writeFileSync(path.join(pub,'request.json'),JSON.stringify({id:id.repeat(32),action,facts_id:facts.id,requested_at:now}));
 const previousMask=process.umask(0o077);
 try {
  let facts=run();temporaryRunning=true;facts=run();assert.equal(facts.maintenance_active,true);request(facts,'snapshot','9');facts=run();assert.equal(facts.receipt.reason,'maintenance_active');assert.ok(!calls.some(a=>a[0]==='stop'));temporaryRunning=false;facts=run();assert.equal(fs.statSync(path.join(pub,'facts.json')).mode&0o777,0o644);request(facts,'snapshot','a');facts=run();assert.equal(facts.receipt.status,'snapshotted');
  const baseline=fs.readFileSync(path.join(priv,'last-good.json'),'utf8');
  fs.writeFileSync(path.join(data,'database.db'),JSON.stringify({type:'Coordinator',ieeeAddr:'0x0000000000000001'}));
  facts=run();request(facts,'snapshot','c');facts=run();assert.equal(facts.receipt.status,'failed');assert.equal(fs.readFileSync(path.join(priv,'last-good.json'),'utf8'),baseline);
  request(facts,'restore','d');facts=run();assert.equal(facts.receipt.status,'dispatched');assert.equal(fs.readFileSync(path.join(data,'database.db'),'utf8'),f.database);
  const mutations=calls.filter(a=>['start','stop'].includes(a[0]));assert.deepEqual(mutations.map(a=>a.at(-1)),['zigbee2mqtt','zigbee2mqtt']);
  assert.equal(calls.filter(a=>a[0]==='run'&&a.includes(adapterRestoreScript)).length,1,'loss restores radio keys as well as database');
  run();assert.equal(calls.filter(a=>['start','stop'].includes(a[0])).length,2,'same request never runs twice');
  assert.ok(calls.every(a=>!a.includes('publish')&&!a.includes('set')));
  const jf=path.join(priv,'journal.json'),j=JSON.parse(fs.readFileSync(jf,'utf8'));j.receipts.push({id:'f'.repeat(32),action:'restore',status:'running'});fs.writeFileSync(jf,JSON.stringify(j));
  facts=run();request(facts,'snapshot','e');facts=run();assert.equal(facts.receipt.reason,'operation_unresolved');
  assert.ok(JSON.parse(fs.readFileSync(jf,'utf8')).receipts.some(r=>r.id==='f'.repeat(32)&&r.status==='running'));
 }finally {process.umask(previousMask);fs.rmSync(root,{recursive:true,force:true});}
});
test('reviewed radio restoration forces NV recovery when a blank network already started',async()=>{
 for(const [result,version,expectedRestores,failed] of [['resumed','11.2.0',1,false],['restored','11.2.0',0,false],['reset','11.2.0',0,true],['resumed','99.0.0',0,true]]){
  let restored=0,stopped=0,created=0;const fakeProcess={exitCode:0};
  const adapter={start:async()=>result,stop:async()=>stopped++,adapterManager:{beginRestore:async()=>restored++}};
  const {config}=fixture();config.serial={adapter:'zstack',port:'tcp://192.0.2.1:7638'};
  const require=name=>name==='fs'?{readFileSync:()=>JSON.stringify(config)}:name==='js-yaml'?{load:JSON.parse}:name==='zigbee-herdsman/package.json'?{version}:{Adapter:{create:async()=>{created++;return adapter}}};
  vm.runInNewContext(adapterRestoreScript,{require,process:fakeProcess});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(restored,expectedRestores);assert.equal(fakeProcess.exitCode,failed?1:0);assert.equal(stopped,created);
 }
});

test('capture preserves only protected keyless router metadata without rolling back native counters',()=>{
 const f=fixture();f.backup.devices.push({ieee_address:'0000000000000003',nwk_address:'1234',is_child:false});
 f.database+='\n'+JSON.stringify({type:'Router',ieeeAddr:'0x0000000000000003',lastSeen:now,interviewCompleted:true});
 const validated=validateNetwork(f.config,f.backup,f.database);
 const makeBaseline=(backup=f.backup)=>{const b={version:1,saved_at:now,identity:validated.identity,devices:2,configuration:JSON.stringify(f.config),database:f.database,backup:JSON.stringify(backup)};b.digest=crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');return b};
 const native=structuredClone(f.backup);native.devices.pop();native.network_key.frame_counter=999999;
 const result=captureNetwork(f.config,native,f.database,makeBaseline());
 assert.equal(result.devices,2);assert.equal(result.preserved_membership_count,1);assert.equal(result.backup.network_key.frame_counter,999999);assert.equal(native.devices.length,1);
 assert.deepEqual(result.backup.devices[1],f.backup.devices[1]);
 assert.throws(()=>captureNetwork(f.config,native,f.database,null));
 assert.throws(()=>captureNetwork(f.config,native,f.database,{...makeBaseline(),digest:'corrupt'}));
 for(const field of ['channel','pan_id','extended_pan_id','coordinator_ieee']){const bad=structuredClone(native);bad[field]=field==='channel'?25:'wrong';assert.throws(()=>captureNetwork(f.config,bad,f.database,makeBaseline()))}
 const secured=structuredClone(f.backup);secured.devices[1].link_key={key:'11'.repeat(16),tx_counter:100,rx_counter:100};
 assert.throws(()=>captureNetwork(f.config,native,f.database,makeBaseline(secured)));
 assert.throws(()=>captureNetwork(f.config,{...native,devices:[]},f.database,makeBaseline()));
 const extra=f.database+'\n'+JSON.stringify({type:'Router',ieeeAddr:'0x0000000000000004',lastSeen:now,interviewCompleted:true});
 assert.throws(()=>captureNetwork(f.config,native,extra,makeBaseline()));
 assert.throws(()=>captureNetwork(f.config,native,f.database.replace('"type":"Router","ieeeAddr":"0x0000000000000003"','"type":"EndDevice","ieeeAddr":"0x0000000000000003"'),makeBaseline()));
});
