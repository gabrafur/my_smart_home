import test from 'node:test';
import assert from 'node:assert/strict';
import {route,extraDescriptors} from './expanded-server.mjs';
test('original five plus six operations; write annotations explicit',async()=>{
 const result=await route({jsonrpc:'2.0',id:1,method:'tools/list'},()=>({}),()=>{});
 assert.equal(result.result.tools.length,11);
 assert.equal(extraDescriptors.find(x=>x.name==='change_apply').annotations.readOnlyHint,false);
 assert.equal(extraDescriptors.find(x=>x.name==='change_apply').annotations.destructiveHint,true);
});
test('metadata ignored and no args persisted; audit before side effects',async()=>{
 const logs=[];let called=false;
 const request={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'change_apply',arguments:{host:'raspberry',change_id:'a'.repeat(32)},_meta:{context:'private'}}};
 const result=await route(request,()=>({}),x=>logs.push(x),async p=>{assert.equal(logs[0].outcome,'started');called=true;return {status:'applied'};});
 assert(called);assert.equal(result.result.structuredContent.status,'applied');
 assert(!JSON.stringify(logs).includes('private'));assert(!JSON.stringify(logs).includes('change_id'));
});
test('malformed protocol never invokes broker',async()=>{
 let called=false;
 const result=await route({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'change_apply',arguments:{},_meta:null}},()=>({}),()=>{},async()=>{called=true;});
 assert.equal(called,false);assert(result.result.isError);
});
test('original disk read preserved without operation broker',async()=>{
 let called=false;
 const result=await route({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'disk_space',arguments:{host:'raspberry'}}},()=>({observed_at:'2026-10-19T12:00:00Z',disk:{total_bytes:100,available_bytes:50}}),()=>{},async()=>{called=true;});
 assert.equal(called,false);assert.equal(result.result.structuredContent.data.available_bytes,50);
});
