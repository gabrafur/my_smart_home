import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {listenerObservation,listenerReady,recoverCodexRemote,restartCodexRemote} from './codex-remote-recovery.mjs';
import {collectCodexRemoteHealth} from './codex-remote-health-publisher.mjs';

const socket='/synthetic/listener.sock';
const absent={status:0,stdout:''};
const present={status:0,stdout:`LISTEN ${socket}\n`};
const failures=[{status:1,stderr:'PRIVATE_SENTINEL'},{status:null,error:Error('PRIVATE_SENTINEL')},
 {status:0,error:Error('PRIVATE_SENTINEL'),stdout:''},{status:0,signal:'SIGTERM',stdout:''},
 {status:0,stdout:null},null];

test('failed, timed out and thrown listener observations are unknown',()=>{
 for(const result of failures){
  assert.equal(listenerObservation(socket,()=>result).state,'unknown');
  assert.equal(listenerReady(socket,()=>result),null);
 }
 assert.equal(listenerObservation(socket,()=>{throw Error('private')}).state,'unknown');
 assert.equal(listenerReady(socket,()=>absent),false);
 assert.equal(listenerReady(socket,()=>present),true);
});

test('initial or rechecked unknown never launches or terminates',()=>{
 for(const result of failures){
  let checks=0;
  const options={controlSocket:socket,activity:()=>({state:'idle',no_effects:true}),
   run:command=>command==='ss'?(++checks,result):({status:0,stdout:'version'}),
   launch:()=>assert.fail('launch forbidden'),terminate:()=>assert.fail('termination forbidden')};
  assert.equal(recoverCodexRemote(options).status,'deferred');
  assert.equal(restartCodexRemote(options).status,'deferred');
  let ss=0;
  assert.equal(recoverCodexRemote({...options,run:command=>command==='ss'?(++ss===1?absent:result):({status:0})}).status,'deferred');
 }
});

test('listener appearing during version check prevents a redundant launch',()=>{
 let calls=0;
 const out=recoverCodexRemote({controlSocket:socket,run:command=>command==='ss'?(++calls===1?absent:present):({status:0}),
  launch:()=>assert.fail('must preserve concurrently started listener')});
 assert.equal(out.status,'healthy');
});

test('unknown shutdown observation never starts a replacement',()=>{
 let stopped=false,terminations=0;
 const out=restartCodexRemote({controlSocket:socket,activity:()=>({state:'idle',no_effects:true}),
  run:(command,args)=>command!=='ss'?({status:0}):stopped?({status:1}):
   ({status:0,stdout:args.includes('-xlpn')?`LISTEN ${socket} users:(("codex",pid=1234,fd=9))\n`:present.stdout}),
  readFile:()=>Buffer.from('codex\0app-server\0--listen\0unix://synthetic\0'),
  terminate:()=>{stopped=true;terminations++;},launch:()=>assert.fail('replacement forbidden'),wait:()=>{}});
 assert.equal(out.status,'deferred');assert.equal(out.reason,'shutdown_observation_unconfirmed');assert.equal(terminations,1);
});

test('lost startup observation is deferred and never called recovered',()=>{
 let calls=0,launches=0;
 const out=restartCodexRemote({controlSocket:socket,activity:()=>({state:'idle',no_effects:true}),
  run:command=>command==='ss'?(++calls===1?absent:({status:1})):({status:0}),
  launch:()=>{launches++;return {unref(){}};},wait:()=>{}});
 assert.equal(out.status,'deferred');assert.equal(out.reason,'startup_observation_unconfirmed');assert.equal(launches,1);
});

function functions(){
 const root=new URL('../nodered/tools/functions/',import.meta.url),values=new Map();
 const flow={get:(key,store)=>values.get(`${store??'default'}:${key}`),set:(key,value,store)=>values.set(`${store??'default'}:${key}`,value)};
 const load=name=>vm.runInNewContext(`(function(msg,flow){${fs.readFileSync(new URL(name,root),'utf8')}\n})`,{Buffer,Date,Number,String});
 return {ingest:load('internet-remote-access-report-ingest.js'),facts:load('internet-remote-access-facts-read.js'),flow};
}

function published(listenerResult){return collectCodexRemoteHealth({controlSocket:socket,now:new Date('2026-10-25T21:00:00Z'),
 run:command=>command==='ss'?listenerResult:command==='systemctl'?({status:0,stdout:'active'}):({status:0})});}

test('publisher through actual Node-RED functions keeps unknown nonrecoverable',()=>{
 for(const result of failures){
  const report=published(result);assert.equal(report.schema_version,2);
  assert.equal(report.services.codex_remote.healthy,null);
  assert.equal(report.services.codex_remote.listener_state,'unknown');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_SENTINEL'));
  const {ingest,facts,flow}=functions();let msg=ingest({_internet_test:true,payload:report},flow);
  assert.equal(msg.remote_access_report_valid,true);
  msg.policy={remote_access_report_stale_s:180,remote_access_recovery_cooldown_s:300};
  msg.remote_access_now=Date.parse(report.checked_at);msg.internet_state={phase:'online'};
  msg=facts(msg,flow);assert.equal(msg.remote_access.codex_observation_state,'unknown');
  assert.equal(msg.remote_access.report_ready,false);assert.equal(msg.remote_access.codex_recoverable,false);
 }
});

test('known absent and present remain distinct after ingest',()=>{
 for(const result of [absent,present]){
  const report=published(result),{ingest,facts,flow}=functions();let msg=ingest({_internet_test:true,payload:report},flow);
  msg.policy={remote_access_report_stale_s:180,remote_access_recovery_cooldown_s:300};
  msg.remote_access_now=Date.parse(report.checked_at);msg=facts(msg,flow);
  assert.equal(msg.remote_access.report_ready,true);
  assert.equal(msg.remote_access.codex_recoverable,result===absent);
 }
});

test('legacy false and conflicting new reports never admit a repair',()=>{
 const {ingest,facts,flow}=functions();const old=published(absent);old.schema_version=1;delete old.services.codex_remote.listener_state;
 let msg=ingest({_internet_test:true,payload:old},flow);
 msg.policy={remote_access_report_stale_s:180,remote_access_recovery_cooldown_s:300};
 msg.remote_access_now=Date.parse(old.checked_at);msg=facts(msg,flow);
 assert.equal(msg.remote_access.report_ready,false);assert.equal(msg.remote_access.codex_recoverable,false);
 for(const alter of [r=>r.services.codex_remote.healthy=false,r=>r.services.codex_remote.listener_state='private']){
  const report=published({status:1});alter(report);
  assert.equal(ingest({_internet_test:true,payload:report},flow).remote_access_report_valid,false);
 }
});

test('an unresolved alias loop stays unknown and cannot launch recovery',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'listener-alias-')),alias=path.join(dir,'loop');
 try{
  fs.symlinkSync('loop',alias);
  assert.equal(listenerObservation(alias,()=>({status:0,stdout:''})).state,'unknown');
  assert.equal(recoverCodexRemote({controlSocket:alias,run:()=>({status:0,stdout:''}),
   launch:()=>assert.fail('cannot launch with unresolvable listener identity')}).status,'deferred');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
