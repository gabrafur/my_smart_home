import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn}from 'node:child_process';
import fs from 'node:fs';

const id='c'.repeat(32),sha='a'.repeat(64);
const url=new URL('./offsite-bootstrap-channel.mjs',import.meta.url).href;
function reply(change={}){
  const [seconds,fraction]=fs.readFileSync('/proc/uptime','utf8').split(' ')[0].split('.');
  return {action:'admit_remote',operation_id:id,phase:'bootstrap_remote_intent',newly_recorded:true,
    worker_witness_recorded:true,dispatch_executed:false,automatic_retry:false,independent_acceptance:false,
    remote_effect_proven:false,expires_at:Date.now()/1000+60,
    deadline_ns:((BigInt(seconds)*100n+BigInt(fraction)+6000n)*10000000n).toString(),...change};
}
async function fixture(body,handler){
  const child=spawn(process.execPath,['--input-type=module','-e',
    `import{connectBootstrapChannel}from ${JSON.stringify(url)};const c=connectBootstrapChannel(3,{operationId:'${id}'});${body}`],
    {stdio:['ignore','pipe','pipe','pipe'],env:{PATH:process.env.PATH}});
  let buffer='',output='',errors='',messages=[];
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  child.stdio[3].on('error',()=>{});child.stdio[3].on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')){
      const end=buffer.indexOf('\n'),value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);messages.push(value);handler(value,child.stdio[3]);
    }
  });
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,0,errors);return {messages,output:JSON.parse(output)};
}
const admission=`{bundleSha256:'${sha}',requestSha256:'${sha}'}`;
test('inherited channel records one admission and report without payloads or authority claims',async()=>{
  const r=await fixture(`const a=await c.admitRemote(${admission});const b=await c.recordReport('${sha}');console.log(JSON.stringify({a,b}));`,
    (v,s)=>s.write(JSON.stringify(v.action==='admit_remote'?reply():{action:'record_report',operation_id:id,phase:'bootstrap_report_recorded',independent_acceptance:false,automatic_retry:false})+'\n'));
  assert.equal(r.messages.length,2);assert.deepEqual(Object.keys(r.messages[0]).sort(),['action','bundle_sha256','request_sha256']);
  assert.equal(r.output.b.independentAcceptance,false);
});
test('a lost response consumes local admission and never writes a second request',async()=>{
  const r=await fixture(`let denied=0;for(let i=0;i<2;i++){try{await c.admitRemote(${admission})}catch{denied++}}console.log(JSON.stringify({denied}));c.close();`,
    (_v,s)=>s.destroy());
  assert.equal(r.messages.length,1);assert.equal(r.output.denied,2);
});
test('expired, mismatched, unbound and completed responses never become a dispatch permission',async()=>{
  for(const change of [{expires_at:1},{operation_id:'d'.repeat(32)},{worker_witness_recorded:false},
    {deadline_ns:'1'},{newly_recorded:false},{dispatch_executed:true},{independent_acceptance:true}]){
    const r=await fixture(`let denied=false;try{await c.admitRemote(${admission})}catch{denied=true}c.close();console.log(JSON.stringify({denied}));`,
      (_v,s)=>s.write(JSON.stringify(reply(change))+'\n'));
    assert.equal(r.output.denied,true);assert.equal(r.messages.length,1);
  }
});
test('second admission and second report cannot produce extra IPC requests',async()=>{
  const r=await fixture(`await c.admitRemote(${admission});let denied=0;try{await c.admitRemote(${admission})}catch{denied++}await c.recordReport('${sha}');try{await c.recordReport('${sha}')}catch{denied++}console.log(JSON.stringify({denied}));`,
    (v,s)=>s.write(JSON.stringify(v.action==='admit_remote'?reply():{action:'record_report',operation_id:id,phase:'bootstrap_report_recorded',independent_acceptance:false,automatic_retry:false})+'\n'));
  assert.equal(r.output.denied,2);assert.equal(r.messages.length,2);
});
test('malformed replies expose only fixed diagnostic codes and consume admission',async()=>{
  for(const [frame,code]of [['null\n','ADMISSION_REPLY'],['untrusted-reply-detail\n','REPLY_JSON'],
    ['x'.repeat(4097),'REPLY_SIZE'],['{}\n{}\n','REPLY_FRAME']]){
    const r=await fixture(`const errors=[];for(let i=0;i<2;i++){try{await c.admitRemote(${admission})}catch(e){errors.push({code:e.code,message:e.message})}}c.close();console.log(JSON.stringify({errors}));`,
      (_v,s)=>s.write(frame));
    assert.equal(r.messages.length,1);
    assert.equal(r.output.errors[0].code,`BOOTSTRAP_${code}`);
    assert.equal(r.output.errors[1].code,'BOOTSTRAP_ADMISSION_CONSUMED_OR_INVALID');
    assert.ok(r.output.errors.every(e=>e.message==='first backup Root channel is unconfirmed; automatic retry is disabled'));
  }
});
test('dispatch invokes the synchronous wire callback once after the Root reply',async()=>{
  const r=await fixture(`let sent=0;await c.dispatchRemote({...${admission},send:()=>{sent++}});let denied=false;try{await c.dispatchRemote({...${admission},send:()=>{sent++}})}catch{denied=true}c.close();console.log(JSON.stringify({sent,denied}));`,
    (_v,s)=>s.write(JSON.stringify(reply())+'\n'));
  assert.equal(r.messages.length,1);assert.deepEqual(r.output,{sent:1,denied:true});
});
test('expiry after the admission await prevents the wire callback and consumes the attempt',async()=>{
  const r=await fixture(`const clock=Date.now;let checks=0,sent=0;Date.now=()=>++checks===1?clock():Number.MAX_SAFE_INTEGER;let code;try{await c.dispatchRemote({...${admission},send:()=>{sent++}})}catch(e){code=e.code}c.close();console.log(JSON.stringify({sent,code}));`,
    (_v,s)=>s.write(JSON.stringify(reply())+'\n'));
  assert.equal(r.messages.length,1);assert.deepEqual(r.output,{sent:0,code:'BOOTSTRAP_WALL_EXPIRED'});
});
test('expiry during synchronous source validation is checked before the wire callback',async()=>{
  const r=await fixture(`let sent=0,code;try{await c.dispatchRemote({...${admission},beforeSend:()=>{Date.now=()=>Number.MAX_SAFE_INTEGER},send:()=>{sent++}})}catch(e){code=e.code}c.close();console.log(JSON.stringify({sent,code}));`,
    (_v,s)=>s.write(JSON.stringify(reply())+'\n'));
  assert.equal(r.messages.length,1);assert.deepEqual(r.output,{sent:0,code:'BOOTSTRAP_WALL_EXPIRED'});
});
test('expiry during an asynchronous metadata refresh prevents the wire callback',async()=>{
  const r=await fixture(`let sent=0,code;try{await c.dispatchRemote({...${admission},prepareBeforeSend:async()=>{await Promise.resolve();Date.now=()=>Number.MAX_SAFE_INTEGER},send:()=>{sent++}})}catch(e){code=e.code}c.close();console.log(JSON.stringify({sent,code}));`,
    (_v,s)=>s.write(JSON.stringify(reply())+'\n'));
  assert.equal(r.messages.length,1);assert.deepEqual(r.output,{sent:0,code:'BOOTSTRAP_WALL_EXPIRED'});
});
