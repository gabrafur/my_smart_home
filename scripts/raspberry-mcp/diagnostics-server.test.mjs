import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {route,diagnosticDescriptors} from './diagnostics-server.mjs';
const request=(id,name='maintenance_capabilities')=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{host:'raspberry'},_meta:{fixture:true}}});
test('sixteen unique tools preserve existing eleven',async()=>{
 const result=await route({jsonrpc:'2.0',id:1,method:'tools/list'},undefined,()=>{});
 assert.equal(result.result.tools.length,16);
 assert.equal(new Set(result.result.tools.map(x=>x.name)).size,16);
 assert(diagnosticDescriptors.every(x=>x.annotations.readOnlyHint&&!x.annotations.openWorldHint));
});
test('sequential and concurrent routing preserve ids and names',async()=>{
 const invoke=async params=>({tool:params.name});
 for(let id=1;id<4;id++)assert.equal((await route(request(id),undefined,()=>{},invoke)).id,id);
 const results=await Promise.all([10,11].map(id=>route(request(id),undefined,()=>{},invoke)));
 assert.deepEqual(results.map(x=>x.id),[10,11]);
 assert(results.every(x=>x.result.structuredContent.tool==='maintenance_capabilities'));
});
test('bad metadata never invokes broker',async()=>{
 let calls=0;const req=request(1);req.params._meta='bad';
 const result=await route(req,undefined,()=>{},async()=>{calls++;});
 assert(result.result.isError);assert.equal(calls,0);
});
test('audit records actual tool and omits payload',async()=>{
 const rows=[];await route(request(1),undefined,row=>rows.push(row),async()=>({ok:true}));
 assert(rows.every(row=>row.tool==='maintenance_capabilities'));
 assert(!JSON.stringify(rows).includes('fixture'));
});
test('broker failure is safe and never retried',async()=>{
 let calls=0;const result=await route(request(1),undefined,()=>{},async()=>{calls++;throw Error('PRIVATE DATA');});
 assert(result.result.isError);assert.equal(calls,1);assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('fresh stdio processes accept sequential lists after reconnect',async()=>{
 async function probe(){
  const child=spawn(process.execPath,[new URL('./diagnostics-server.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);
  child.stdin.end([1,2].map(id=>JSON.stringify({jsonrpc:'2.0',id,method:'tools/list'})+'\n').join(''));
  const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,0);
  const rows=output.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(x=>x.id),[1,2]);
  assert(rows.every(x=>x.result.tools.length===16));
 }
 await probe();await probe();
});
