import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire}from 'node:module';
import {once}from 'node:events';
import {prepareBootstrapUpload,savedBackupProfileSha256}from './offsite-bootstrap-upload.mjs';
const {WebSocket,WebSocketServer}=createRequire(import.meta.url)('../nodered/node_modules/ws');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const H='a'.repeat(64),ID='c'.repeat(32);
function profile(){return {schema_version:1,scope:'ha_saved_backup_profile_v1',agent_id:'onedrive.fixture',
  password_configured:true,provider_protected:true,include_database:false,include_all_addons:false,
  include_addons:[],include_folders:[],delete_permanently:false,
  native_retention:{all_agents_covered:true,global:{copies:null,days:null},agents:[{agent_id:'onedrive.fixture',copies:null,days:null}]}};}
async function fixture(t,options={}){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  t.after(async()=>{for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));});
  const wire=[],events=[],admissions=[],reports=[];
  let reads=0,sourceChecks=0;
  let profileChecks=0;
  server.on('connection',socket=>{
    socket.send(JSON.stringify({type:'auth_required'}));
    socket.on('message',raw=>{
      const message=JSON.parse(raw);wire.push(message);
      if(message.type==='auth'){
        socket.send(JSON.stringify({type:options.authInvalid?'auth_invalid':'auth_ok'}));
        if(options.duplicateAuth)socket.send(JSON.stringify({type:'auth_ok'}));return;
      }
      if(message.type==='backup/info'){
        const state=options.busy&&reads++===0?'create_backup':'idle';
        socket.send(JSON.stringify({id:message.id,type:'result',success:true,result:{state,backups:[],agent_errors:{}}}));return;
      }
      events.push('generation_received');
      assert.equal(message.type,'backup/generate_with_automatic_settings');
      assert.deepEqual(Object.keys(message).sort(),['id','type']);
      assert.equal(admissions.at(-1).requestSha256,sha(raw));
      if(options.dropGeneration){socket.terminate();return;}
      socket.send(JSON.stringify({id:message.id,type:'result',success:!options.rejectGeneration,
        result:options.badJob?{backup_job_id:null}:{backup_job_id:'fixture_job'},error:{message:'untrusted-reply-detail'}}));
    });
  });
  class OwnedWebSocket extends WebSocket{constructor(url){
    assert.equal(url,'ws://127.0.0.1:8123/api/websocket');super(`ws://127.0.0.1:${server.address().port}`);
  }}
  const channel={async dispatchRemote(value){
    admissions.push({bundleSha256:value.bundleSha256,requestSha256:value.requestSha256});events.push('root_intent');
    if(options.denyAdmission)throw Error('untrusted-admission-detail');
    if(options.lateAdmission)await new Promise(resolve=>setTimeout(resolve,80));
    value.beforeSend();value.send();return {operationId:ID,automaticRetry:false};
  },async recordReport(hash){events.push('root_report');reports.push(hash);}};
  const upload=prepareBootstrapUpload({channel,bundleSha256:H,token:'synthetic-only',WebSocket:OwnedWebSocket,
    expectedProfileSha256:savedBackupProfileSha256(profile()),readSavedProfile:()=>{
      const p=profile();const changed=profileChecks++>0;
      if(options.retentionEnabled||options.changeProfile&&changed)p.native_retention.global.copies=2;
      if(options.replaceProfile&&changed){p.agent_id='onedrive.other';p.native_retention.agents[0].agent_id=p.agent_id;}return p;
    },
    timeoutMs:options.lateAdmission||options.slowSource?30:1000,readinessTimeoutMs:1000,pollIntervalMs:1,
    validateSource:()=>{sourceChecks++;if(sourceChecks>1&&options.slowSource)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);return sourceChecks===1||!options.changeSource;},
    recordLocalReport:async value=>{events.push('local_report');reports.push(value);return !options.failLocalReport;}});
  return {upload,wire,events,admissions,reports};
}
test('one automatic-settings request uses the inherited admission and persists data before Root report',async t=>{
  const f=await fixture(t,{busy:true});const result=await f.upload.run();
  assert.deepEqual(f.events,['root_intent','generation_received','local_report','root_report']);
  assert.equal(f.admissions.length,1);assert.equal(f.admissions[0].bundleSha256,H);
  assert.deepEqual(f.wire.map(m=>m.type),['auth','backup/info','backup/info','backup/generate_with_automatic_settings']);
  assert.equal(f.reports[1],sha(JSON.stringify(result.report)));
  assert.equal(result.report.backup_job_id_sha256,sha('fixture_job'));
  assert.equal(result.report.independent_acceptance,false);assert.equal(result.report.remote_effect_proven,false);
  assert.equal(result.report.policy_promoted,false);assert.equal(result.report.automatic_retry,false);
  await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_CONSUMED'});
});
test('saved settings reject native cleanup, incomplete coverage, unprotected backup and secret fields',()=>{
  for(const change of [p=>p.native_retention.global.copies=2,p=>p.native_retention.global.days=7,
    p=>p.native_retention.agents[0].copies=1,p=>p.native_retention.all_agents_covered=false,
    p=>p.password_configured=false,p=>p.provider_protected=false,p=>p.delete_permanently=true,
    p=>p.password='synthetic-only',p=>p.include_database=true]){
    const p=profile();change(p);assert.throws(()=>savedBackupProfileSha256(p),{code:'BOOTSTRAP_UPLOAD_PROFILE'});
  }
});
test('native retention blocks before authentication and a changed profile blocks before generation',async t=>{
  for(const options of [{retentionEnabled:true},{changeProfile:true},{replaceProfile:true}])await t.test(JSON.stringify(options),async t=>{
    const f=await fixture(t,options);await assert.rejects(f.upload.run());
    assert.equal(f.wire.filter(m=>m.type==='backup/generate_with_automatic_settings').length,0);
    assert.equal(f.admissions.length,options.retentionEnabled?0:1);
    if(options.retentionEnabled)assert.equal(f.wire.length,0);
    assert.equal(f.reports.length,0);
  });
});
test('lost or rejected generation responses never cause a second request or Root report',async t=>{
  for(const options of [{dropGeneration:true},{rejectGeneration:true},{badJob:true}])await t.test(JSON.stringify(options),async t=>{
    const f=await fixture(t,options);await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_GENERATION_UNCONFIRMED'});
    await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_CONSUMED'});
    assert.equal(f.wire.filter(m=>m.type==='backup/generate_with_automatic_settings').length,1);assert.equal(f.reports.length,0);
  });
});
test('admission failure or a source change prevents the wire effect after readiness',async t=>{
  for(const options of [{denyAdmission:true},{changeSource:true}])await t.test(JSON.stringify(options),async t=>{
    const f=await fixture(t,options);await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_GENERATION_UNCONFIRMED'});
    assert.equal(f.admissions.length,1);assert.equal(f.wire.filter(m=>m.type==='backup/generate_with_automatic_settings').length,0);
    assert.equal(f.reports.length,0);
  });
});
test('an admission arriving after the response timeout cannot send generation',async t=>{
  const f=await fixture(t,{lateAdmission:true});await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_GENERATION_UNCONFIRMED'});
  assert.equal(f.admissions.length,1);assert.equal(f.wire.filter(m=>m.type==='backup/generate_with_automatic_settings').length,0);
});
test('source validation crossing the response deadline cannot send even before the timer callback runs',async t=>{
  const f=await fixture(t,{slowSource:true});await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_GENERATION_UNCONFIRMED'});
  assert.equal(f.admissions.length,1);assert.equal(f.wire.filter(m=>m.type==='backup/generate_with_automatic_settings').length,0);
});
test('duplicate or invalid authentication never reaches Root admission',async t=>{
  for(const options of [{duplicateAuth:true},{authInvalid:true}])await t.test(JSON.stringify(options),async t=>{
    const f=await fixture(t,options);await assert.rejects(f.upload.run());assert.equal(f.admissions.length,0);assert.equal(f.reports.length,0);
  });
});
test('failure to persist the local report preserves consumption without reporting success to Root',async t=>{
  const f=await fixture(t,{failLocalReport:true});await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_LOCAL_REPORT_UNCONFIRMED'});
  assert.equal(f.wire.filter(m=>m.type==='backup/generate_with_automatic_settings').length,1);
  assert.equal(f.reports.length,1);assert.equal(f.events.includes('root_report'),false);
  await assert.rejects(f.upload.run(),{code:'BOOTSTRAP_UPLOAD_CONSUMED'});
});
