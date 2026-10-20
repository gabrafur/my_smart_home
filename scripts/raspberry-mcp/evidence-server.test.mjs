import test from 'node:test';
import assert from 'node:assert/strict';
import {route} from './evidence-server.mjs';
test('preserves sixteen names and old required inputs',async()=>{
 const row=await route({jsonrpc:'2.0',id:1,method:'tools/list'},undefined,()=>{});
 assert.equal(row.result.tools.length,16);assert.equal(new Set(row.result.tools.map(x=>x.name)).size,16);
 const log=row.result.tools.find(x=>x.name==='log_summary');assert.deepEqual(log.inputSchema.required,['host','service']);assert(log.inputSchema.properties.offset);
});
test('existing backup name routes to broker with original arguments',async()=>{
 let seen;const row=await route({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'backup_results',arguments:{host:'raspberry'}}},undefined,()=>{},async params=>{seen=params;return {data:{git:{reason:'maintenance_busy'}}};});
 assert.equal(seen.name,'backup_results');assert.equal(row.result.structuredContent.data.git.reason,'maintenance_busy');
});
test('bad protocol metadata rejected without invoking collector',async()=>{
 let calls=0;const row=await route({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'log_summary',arguments:{host:'raspberry',service:'nodered'},_meta:[]}},undefined,()=>{},async()=>{calls++;});
 assert(row.result.isError);assert.equal(calls,0);
});
