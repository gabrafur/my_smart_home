'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),test=require('node:test'),assert=require('node:assert/strict');
const m=require('./kia-runtime-facts.cjs');
const source=fs.readFileSync(path.join(__dirname,'ha-collector.cjs'),'utf8');
const identity={role:'approved_existing_administrator',user_id_sha256:crypto.createHash('sha256').update('synthetic-user').digest('hex')};
const entities=Object.fromEntries(m.ROLES.map(([role,domain,suffix])=>[role,domain+'.synthetic'+suffix]));
const binding={schema_version:1,scope:m.SCOPE,enabled:true,approval_sha256:'a'.repeat(64),entities};
const facts={schema_version:1,rows:m.ROLES.map(([role])=>({role,state_kind:'value',native_scanned_at:role==='scanned'?'2026-01-01T00:00:00Z':null}))};
function fixture({wrongUser=false,armed=true,nativeStatus=200,unexpected=false}={}){
 const calls=[];
 class WS extends EventEmitter{
  constructor(){super();queueMicrotask(()=>this.emit('message',JSON.stringify({type:'auth_required'})))}
  terminate(){}
  send(raw){const q=JSON.parse(raw);calls.push(q.type);let value;
   if(q.type==='auth')value={type:'auth_ok'};
   else if(q.type==='auth/current_user')value={type:'result',id:1,success:true,result:{id:wrongUser?'other':'synthetic-user',is_owner:false,is_admin:true}};
   else if(q.type==='manifest/get')value={type:'result',id:2,success:true,result:{domain:'kia_uvo',version:'3.19.0'}};
   else throw Error('unapproved_ws_call');
   queueMicrotask(()=>this.emit('message',JSON.stringify(value)));
  }
 }
 const transport={request(options,callback){const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
  req.end=()=>{calls.push(options.method+' '+options.path);queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=options.method==='GET'?200:nativeStatus;callback(res);res.emit('data',Buffer.from(JSON.stringify(options.method==='GET'?{entity_id:'sensor.integracao_vehicle_primary',state:'conflict',attributes:{installed_version:'3.19.0'}}:facts)));res.emit('end')})};return req;}};
 const runtime={...m,collectRuntime:(token,verified)=>{calls.push('runtime_collect');if(unexpected)throw Error('PRIVATE_FAILURE');return m.collectRuntime(token,verified,{loadBinding:()=>{if(!armed)throw Error('unarmed');return binding;},transport})}};
 const ctx={module:{exports:{}},require:n=>n==='node:http'?transport:n.includes('/vendor/ws')?WS:n==='./kia-runtime-facts.cjs'?runtime:require(n),Buffer,JSON,Date,Promise,Error,setTimeout,clearTimeout};
 vm.runInNewContext(source,ctx);return {calls,collect:ctx.module.exports.collectHA};
}
test('verified identity precedes both fixed metadata and approved runtime reads',async()=>{
 const f=fixture(),r=await f.collect('PRIVATE_CREDENTIAL',identity);
 assert.equal(r.collection_error,null);assert.equal(r.runtime_manifest.version,'3.19.0');assert.equal(r.sensor.state,'conflict');assert.equal(r.runtime_facts.state,'observed');assert.equal(r.runtime_facts.rows.length,6);assert.equal(r.vehicle_data_read,true);
 assert.equal(f.calls.filter(x=>x==='POST /api/template').length,1);assert.ok(f.calls.indexOf('auth/current_user')<f.calls.indexOf('POST /api/template'));assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('identity mismatch permits neither metadata HTTP nor runtime template',async()=>{
 const f=fixture({wrongUser:true}),r=await f.collect('PRIVATE_CREDENTIAL',identity);assert.equal(r.identity_verified,false);assert.ok(!f.calls.some(x=>/^(GET|POST)/.test(x)));assert.ok(!f.calls.includes('runtime_collect'));
});
test('unarmed native scope leaves existing metadata available and no template request',async()=>{
 const f=fixture({armed:false}),r=await f.collect('fixture',identity);assert.equal(r.collection_error,null);assert.equal(r.sensor.state,'conflict');assert.equal(r.vehicle_data_read,false);assert.equal(r.runtime_facts.state,'unknown');assert.ok(!f.calls.some(x=>x.startsWith('POST')));
});
test('native template refusal preserves existing metadata and reports unknown runtime',async()=>{
 const f=fixture({nativeStatus:403}),r=await f.collect('fixture',identity);assert.equal(r.collection_error,null);assert.equal(r.sensor.state,'conflict');assert.equal(r.runtime_facts.collection_error,'native_template_http_refused');assert.equal(r.runtime_facts.current_functional_health_proven,false);
});
test('unexpected optional probe error cannot hide existing metadata or expose its message',async()=>{
 const f=fixture({unexpected:true}),r=await f.collect('fixture',identity);assert.equal(r.collection_error,null);assert.equal(r.sensor.state,'conflict');assert.equal(r.vehicle_data_read,null);assert.equal(r.runtime_facts.state,'unknown');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
