import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const producer=fileURLToPath(new URL('./runtime-source/native-events/',import.meta.url));
import {makeEventRoute,eventPayloadSchema,payloadContractMetadata} from './runtime-source/frontend/events-server.mjs';
const require=createRequire(new URL('../../validation/package.json',import.meta.url)),Ajv=require('ajv');
import {eventDescriptor as previousDescriptor} from './runtime-source/ha-notices/notices-server.mjs';
const validate=new Ajv({strict:true,allowUnionTypes:true}).compile(eventPayloadSchema);
const fixture=()=>({project:'/mnt/data/docker',topic:'ha_notification',source:'ha_persistent_notification',phase:'added',object_id:'a'.repeat(64),revision:'b'.repeat(64)});
function generated(current=true){
 const script=`import json,sys\nsys.path.insert(0,${JSON.stringify(producer)})\nfrom delivery_summary import group_events,make_batch,iso\nnow=1800000000\nrows=[]\nfor i,phase in enumerate(['added','updated','removed']):\n data={'project':'/mnt/data/docker','topic':'ha_notification','source':'ha_persistent_notification','phase':phase,'object_id':'a'*64,'revision':format(i,'064x')}\n rows.append({'id':format(i+1,'064x'),'body':json.dumps({'eventId':format(i+1,'064x'),'data':data}),'created':now-3+i})\ngroups=group_events(rows,now,${current?'{}':'None'})\nprint(make_batch(groups,'synthetic_subscription',now,${current?'iso(now)':'None'})[1])\n`;
 const result=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',script],{encoding:'utf8',timeout:5000,maxBuffer:32768});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout).data;
}
test('legacy single notification remains valid',()=>assert.equal(validate(fixture()),true,JSON.stringify(validate.errors)));
test('real native summary output, including quick removal, matches advertised contract',()=>{const p=generated();assert.equal(validate(p),true,JSON.stringify(validate.errors));assert.equal(p.notifications[0].current_state,'removed');assert.equal(p.notifications[0].recovery_proven,false);});
test('missing current-state evidence remains representable',()=>{const p=generated(false);assert.equal(validate(p),true,JSON.stringify(validate.errors));assert.equal(p.notifications[0].current_state,'unknown');});
test('catalog route returns the compatible closed alternatives without invoking delivery',async()=>{
 let calls=0;const route=makeEventRoute(async()=>({jsonrpc:'2.0',id:0,result:{events:[{name:'smart_home.observation',payloadSchema:{type:'null'}}]}}),()=>{calls++;throw Error('unexpected delivery')});
 const r=await route({jsonrpc:'2.0',id:'catalog-contract',method:'events/list',params:{}});assert.deepEqual(r.result.events[0].payloadSchema,eventPayloadSchema);assert.equal(calls,0);assert.equal(r.id,'catalog-contract');
});
test('private fields and cross-scope values rejected in either variant',()=>{for(const p of [fixture(),generated()])for(const [k,v]of [['token','synthetic secret'],['project','/etc'],['source','other']]){assert.equal(validate({...p,[k]:v}),false);}});
test('nested raw messages and invented recovery or execution claims rejected',()=>{for(const alter of [p=>p.notifications[0].message='PRIVATE_TEST_SENTINEL',p=>p.notifications[0].recovery_proven=true,p=>p.recovery_proven=true,p=>p.assistant_execution='confirmed']){const p=generated();alter(p);assert.equal(validate(p),false);}});
test('oversized batches, malformed hashes and counts rejected',()=>{for(const alter of [p=>p.notifications=Array(9).fill(p.notifications[0]),p=>p.notifications[0].object_id='raw notification ID',p=>p.covered_event_records=257,p=>p.notifications[0].change_count=-1,p=>p.notifications[0].transition_preview=Array(9).fill('added'),p=>p.notifications[0].current_state='recovered']){const p=generated();alter(p);assert.equal(validate(p),false);}});

test('regression: previous advertised schema rejects the native summary',()=>{const old=new Ajv({strict:true}).compile(previousDescriptor.payloadSchema);assert.equal(old(fixture()),true);assert.equal(old(generated()),false);});

test('actual status route identifies loaded descriptor separately from remote cache and execution',async()=>{const route=makeEventRoute(()=>assert.fail('unexpected legacy'),async(method,args)=>{assert.equal(method,'status');assert.deepEqual(args,{});return {assistant_run_confirmed:false,source:'synthetic'};});const r=await route({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'events_status',arguments:{host:'raspberry'}}});assert.deepEqual(r.result.structuredContent.frontend_payload_contract,payloadContractMetadata);assert.equal(r.result.structuredContent.assistant_run_confirmed,false);assert.deepEqual(JSON.parse(r.result.content[0].text),r.result.structuredContent);assert.match(payloadContractMetadata.schema_sha256,/^[a-f0-9]{64}$/);});
