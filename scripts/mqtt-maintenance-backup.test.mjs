import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {captureWithOrderedStops,loadBackupMaintenance,validateBackupContract} from './mqtt-maintenance-backup.mjs';

const services=['homeassistant','nodered','mosquitto','zigbee2mqtt','matter_server','appdaemon','portainer'];
function fixture(coordinated=true) {
  const events=[],running=new Set(services);
  const stop=selected=>{events.push(['stop',...selected]);selected.forEach(s=>running.delete(s));};
  const start=selected=>{events.push(['start',...selected]);selected.forEach(s=>running.add(s));};
  const maintenance=coordinated?{
    prepare(){stop(['mosquitto']);events.push(['closed_source_ACKed']);stop(['nodered']);},
    resume(){start(['nodered']);events.push(['fresh_reader_checkpoint']);start(['mosquitto']);events.push(['new_source_ACKed']);},
  }:null;
  return {events,running,options:{services,maintenance,stop,start,
    capture(){events.push(['capture']);assert.equal(running.size,0);return {captured:true,components:13};},
    async wait(selected){events.push(['wait',...selected]);assert.deepEqual(new Set(selected),running);}}};
}

test('existing backup preserves the ordinary grouped stop/start path without an installed observer',async()=>{
  const f=fixture(false),r=await captureWithOrderedStops(f.options);
  assert.deepEqual(f.events,[['stop',...services],['capture'],['start',...services],['wait',...services]]);
  assert.equal(r.capture.captured,true);assert.equal(r.captureError,null);assert.equal(r.restorationError,null);
});
test('all seven services are captured offline between the fixed source/consumer maintenance boundaries',async()=>{
  const f=fixture(),r=await captureWithOrderedStops(f.options),ordinary=services.filter(s=>!['nodered','mosquitto'].includes(s));
  assert.deepEqual(f.events,[['stop','mosquitto'],['closed_source_ACKed'],['stop','nodered'],['stop',...ordinary],
    ['capture'],['start',...ordinary],['start','nodered'],['fresh_reader_checkpoint'],['start','mosquitto'],['new_source_ACKed'],['wait',...services]]);
  assert.equal(r.captureError,null);assert.equal(r.restorationError,null);
});
test('capture failure still restores every participant and never reports a valid capture',async()=>{
  const f=fixture(),failure=new Error('synthetic_capture_failure');
  f.options.capture=()=>{throw failure;};const r=await captureWithOrderedStops(f.options);
  assert.equal(r.captureError,failure);assert.equal(r.capture,undefined);assert.equal(r.restorationError,null);
  assert.deepEqual(f.running,new Set(services));assert(f.events.some(e=>e[0]==='new_source_ACKed'));
});
test('ordinary start failure does not prevent the independent Root resume attempt',async()=>{
  const f=fixture(),failure=new Error('synthetic_start_failure');f.options.start=()=>{throw failure;};
  const r=await captureWithOrderedStops(f.options);assert.equal(r.restorationError,failure);
  assert(f.events.some(e=>e[0]==='new_source_ACKed'));assert(!f.events.some(e=>e[0]==='wait'));
});
test('lost prepare response skips capture and attempts journal-validated restoration once',async()=>{
  const f=fixture(),prepare=f.options.maintenance.prepare;
  f.options.maintenance.prepare=()=>{prepare();throw new Error('synthetic_lost_response');};
  const r=await captureWithOrderedStops(f.options);assert(r.captureError);assert.equal(r.restorationError,null);
  assert(!f.events.some(e=>e[0]==='capture'));assert.deepEqual(f.running,new Set(services));
  assert.equal(f.events.filter(e=>e[0]==='new_source_ACKed').length,1);
});
test('unconfirmed Root resume prevents readiness success even when ordinary services started',async()=>{
  const f=fixture();f.options.maintenance.resume=()=>{throw new Error('synthetic_resume_uncertain');};
  const r=await captureWithOrderedStops(f.options);assert(r.restorationError);assert(!f.events.some(e=>e[0]==='wait'));
});
test('readiness failure is retained and a partial service inventory cannot bypass coordination',async()=>{
  const f=fixture();f.options.wait=async()=>{throw new Error('synthetic_readiness_failure');};
  assert((await captureWithOrderedStops(f.options)).restorationError);
  const g=fixture();g.options.services=['homeassistant'];
  await assert.rejects(captureWithOrderedStops(g.options),/coordination/);assert.deepEqual(g.events,[]);
});

function bridge() {
  const code=Buffer.from('synthetic_immutable_helper'),contract={schema_version:1,scope:'mqtt_metadata_backup_plan_v1',
    enabled:true,helper_sha256:crypto.createHash('sha256').update(code).digest('hex'),maximum_command_ms:1000};
  const raw=Buffer.from(JSON.stringify(contract)),calls=[];let current=raw,currentCode=code;
  return {contract,calls,setRaw:v=>current=v,setCode:v=>currentCode=v,options:{
    exists:()=>true,operationId:()=> 'a'.repeat(32),readRoot:file=>file.endsWith('backup-contract.json')?current:currentCode,
    invoke(command,args,options){calls.push({command,args,options});return {status:0,stdout:JSON.stringify({
      state:args.at(-2)==='prepare'?'backup_plan_capture_ready':'backup_plan_complete',operation_id:args.at(-1),
      automatic_retry:false,full24h_proven:false})};}}};
}
test('uninstalled observer uses legacy backup; incomplete installed contract blocks without invoking anything',()=>{
  assert.equal(loadBackupMaintenance({exists:()=>false}),null);
  assert.throws(()=>loadBackupMaintenance({exists:file=>file.endsWith('compose.yml')}),/coordination/);
});
test('Root helper receives only a fixed action and operation with no free paths, targets or environment',()=>{
  const f=bridge(),b=loadBackupMaintenance(f.options);b.prepare();b.resume();assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls.map(c=>c.args.at(-2)),['prepare','resume']);
  assert(f.calls.every(c=>c.command==='/usr/bin/sudo'&&c.args.join(' ').startsWith('-n /usr/bin/python3 -I -S -B /opt/raspberry-mqtt-observation/backup_cli.py ')));
  assert.deepEqual(f.calls[0].options.env,{PATH:'/usr/bin:/bin',LC_ALL:'C'});
  assert.equal(f.calls[0].options.timeout,1000);
});
test('contract or helper code changes block before the privileged call',()=>{
  for(const mutate of [f=>f.setRaw(Buffer.from('{}')),f=>f.setCode(Buffer.from('changed'))]) {
    const f=bridge(),b=loadBackupMaintenance(f.options);mutate(f);assert.throws(()=>b.prepare());assert.equal(f.calls.length,0);
  }
});
test('closed Root contract rejects disabled, unlimited, arbitrary target and non-versioned profiles',()=>{
  const f=bridge();for(const delta of [{enabled:false},{maximum_command_ms:0},{maximum_command_ms:Infinity},
    {helper_sha256:'invalid'},{target:'arbitrary'},{schema_version:2}])
    assert.throws(()=>validateBackupContract({...f.contract,...delta}));
});
test('Root response must bind the current request and never claims a full-day acceptance',()=>{
  const f=bridge();f.options.invoke=()=>({status:0,stdout:JSON.stringify({state:'backup_plan_capture_ready',
    operation_id:'b'.repeat(32),automatic_retry:false,full24h_proven:false})});
  assert.throws(()=>loadBackupMaintenance(f.options).prepare());
});
test('one failed normal resume delegates to the separately sealed rescue without repeating resume',()=>{
  const f=bridge(),original=f.options.invoke;
  f.options.invoke=(command,args,options)=>{
    const action=args.at(-2);
    if(action==='resume'){f.calls.push({command,args,options});return {status:1,stdout:'{}'};}
    if(action==='rescue'){
      f.calls.push({command,args,options});return {status:0,stdout:JSON.stringify({operation_id:'a'.repeat(32),
        state:'backup_rescue_house_running_metadata_disabled',metadata_disabled:true,metadata_integrity:'unknown',
        automatic_retry:false,full24h_proven:false})};
    }
    return original(command,args,options);
  };
  const b=loadBackupMaintenance(f.options);b.prepare();const r=b.resume();
  assert.equal(r.metadata_disabled,true);assert.deepEqual(f.calls.map(c=>c.args.at(-2)),['prepare','resume','rescue']);
});
test('rescued services are health-checked but cannot become a successful metadata backup',async()=>{
  const f=fixture(),resume=f.options.maintenance.resume;
  f.options.maintenance.resume=()=>{resume();return {metadata_disabled:true};};
  const r=await captureWithOrderedStops(f.options);
  assert.deepEqual(f.running,new Set(services));assert(f.events.some(e=>e[0]==='wait'));
  assert.equal(r.restorationError.code,'MQTT_METADATA_BACKUP_RESCUED');
});
test('asynchronous snapshot completion or failure precedes every service resume',async()=>{
 for(const fail of [false,true]){
  const f=fixture();let release;
  f.options.capture=()=>new Promise((resolve,reject)=>{release=()=>fail?reject(new Error('synthetic_stream_failure')):resolve({captured:true});});
  const running=captureWithOrderedStops(f.options);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.running.size,0);assert(!f.events.some(e=>e[0]==='resume'||e[0]==='start'));
  release();const result=await running;
  assert.deepEqual(f.running,new Set(services));assert.equal(!!result.captureError,fail);
 }
});
test('v2 snapshot transport binds its fixed scope and rechecks the Root contract after streaming',async()=>{
 const f=bridge(),contract={...f.contract,schema_version:2,snapshot_scope:'mqtt_metadata_backup_snapshot_v1',
   snapshot_maximum_command_ms:30000,snapshot_component_manifest_sha256:'d'.repeat(64)};
 f.setRaw(Buffer.from(JSON.stringify(contract)));const exported=[];
 f.options.exportSnapshot=async(destination,options)=>{exported.push({destination,options});return {destination};};
 const b=loadBackupMaintenance(f.options);assert.equal(b.snapshot_component_manifest_sha256,'d'.repeat(64));
 await b.snapshot('/tmp/private-test-snapshot');
 assert.equal(exported[0].options.operationId,'a'.repeat(32));assert.equal(exported[0].options.maximumCommandMs,30000);
 f.options.exportSnapshot=async()=>{f.setCode(Buffer.from('changed'));return {};};
 await assert.rejects(loadBackupMaintenance(f.options).snapshot('/tmp/private-test-snapshot-2'));
 for(const delta of [{snapshot_scope:'unknown'},{snapshot_maximum_command_ms:30001},{snapshot_component_manifest_sha256:'invalid'}])
   assert.throws(()=>validateBackupContract({...contract,...delta}));
});

function closedBridge(mode='closed') {
 const f=bridge(),contract={...f.contract,schema_version:3,snapshot_scope:'mqtt_metadata_backup_snapshot_v1',
   snapshot_maximum_command_ms:30000,snapshot_component_manifest_sha256:'d'.repeat(64),
   closed_backup_scope:'mqtt_metadata_closed_backup_v1'};
 f.setRaw(Buffer.from(JSON.stringify(contract)));
 f.options.invoke=(command,args,options)=>{
  f.calls.push({command,args,options});const action=args.at(-2);
  return {status:0,stdout:JSON.stringify({operation_id:args.at(-1),automatic_retry:false,full24h_proven:false,
   ...(action==='mode'?{state:'backup_mode_selected',mode}:mode==='closed'?{
    state:action==='prepare-closed'?'backup_closed_capture_ready':'backup_closed_metadata_complete',
    metadata_integrity:'unknown',source_effects_executed:false,
   }:{state:action==='prepare'?'backup_plan_capture_ready':'backup_plan_complete'})})};
 };
 return f;
}
test('v3 selects a fixed mode before any stop and passes closed mode to the bounded snapshot exporter',async()=>{
 for(const mode of ['live','closed']){
  const f=closedBridge(mode),exports=[];f.options.exportSnapshot=async(...args)=>exports.push(args);
  const b=loadBackupMaintenance(f.options);assert.equal(b.mode,mode);
  assert.deepEqual(f.calls.map(c=>c.args.at(-2)),['mode']);b.prepare();await b.snapshot('/tmp/synthetic-closed');b.resume();
  assert.deepEqual(f.calls.map(c=>c.args.at(-2)),mode==='closed'?['mode','prepare-closed','resume-closed']:['mode','prepare','resume']);
  assert.equal(exports[0][1].mode,mode);
 }
});
test('closed metadata helper never owns service effects and waits for snapshot before ordinary restoration',async()=>{
 for(const fail of [false,true]){
  const f=fixture(false);let release;
  f.options.maintenance={mode:'closed',prepare:()=>f.events.push(['prepare_data']),resume:()=>f.events.push(['complete_data'])};
  f.options.capture=()=>new Promise((resolve,reject)=>{release=()=>fail?reject(new Error('synthetic_copy_failure')):resolve({captured:true});});
  const pending=captureWithOrderedStops(f.options);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.events,[['prepare_data'],['stop',...services]]);assert.equal(f.running.size,0);
  release();const r=await pending;assert.equal(!!r.captureError,fail);assert.equal(r.restorationError,null);
  assert.deepEqual(f.events.slice(2),[['start',...services],['complete_data'],['wait',...services]]);
  assert.deepEqual(f.running,new Set(services));
 }
});
test('closed resume failure cannot invoke live rescue or repeat the closed action',()=>{
 const f=closedBridge(),invoke=f.options.invoke;
 f.options.invoke=(command,args,options)=>{
  if(args.at(-2)==='resume-closed'){f.calls.push({command,args,options});return {status:1,stdout:'{}'};}
  return invoke(command,args,options);
 };
 const b=loadBackupMaintenance(f.options);b.prepare();assert.throws(()=>b.resume());
 assert.deepEqual(f.calls.map(c=>c.args.at(-2)),['mode','prepare-closed','resume-closed']);
});
test('closed results cannot claim source effects or verified integrity and unknown mode fails before preparation',()=>{
 for(const delta of [{metadata_integrity:'verified'},{source_effects_executed:true}]){
  const f=closedBridge(),invoke=f.options.invoke;f.options.invoke=(...args)=>{
   const r=invoke(...args);if(args[1].at(-2)!=='mode')r.stdout=JSON.stringify({...JSON.parse(r.stdout),...delta});return r;
  };
  assert.throws(()=>loadBackupMaintenance(f.options).prepare());
 }
 const f=closedBridge('unknown');assert.throws(()=>loadBackupMaintenance(f.options));
 assert.deepEqual(f.calls.map(c=>c.args.at(-2)),['mode']);
});
