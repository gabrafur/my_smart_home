import test from 'node:test';
import assert from 'node:assert/strict';
import {descriptors,valid,validEnvelope,makeAdminRoute,SOCKET} from './nodered-admin-route.mjs';
import {FrameParser,LEGACY_LIMIT,PREPARE_LIMIT,encodeResponse,encodeRoutedResponse} from './nodered-admin-parser.mjs';
const id='a'.repeat(32), sha='b'.repeat(64);
const args=()=>({host:'raspberry',operation_id:id,expected_revision:'opaque.rev-not-a-sha',
  expected_sha256:sha,edits:[{kind:'create',node:{id:'group__canonical_node.1',type:'comment',name:'candidate'}}]});
const q=(name='nodered_admin_prepare',arguments_=args())=>({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,arguments:arguments_}});
const bytes=x=>Buffer.from(JSON.stringify(x)+'\n');
test('nine closed descriptors and fixed AF_UNIX transport',()=>{
  assert.equal(descriptors.length,9);assert.equal(new Set(descriptors.map(x=>x.name)).size,9);
  assert.equal(SOCKET,'/run/raspberry-mcp/nodered-admin.sock');
  for(const d of descriptors)assert.equal(d.inputSchema.additionalProperties,false);
});
test('opaque revision and double underscore canonical IDs accepted',()=>assert.equal(validEnvelope(q()),true));
test('extra authority fields, arbitrary host and missing node ID rejected',()=>{
  assert.equal(validEnvelope({...q(),path:'/tmp/x'}),false);
  assert.equal(valid('nodered_admin_prepare',{...args(),command:'id'}),false);
  assert.equal(valid('nodered_admin_prepare',{...args(),host:'other'}),false);
  assert.equal(valid('nodered_admin_prepare',{...args(),edits:[{kind:'create',node:{type:'comment'}}]}),false);
});
test('patch closed grammar and prototype-bearing fields rejected',()=>{
  const patch={kind:'patch',node_id:'abc__123.1',expected_node_sha256:sha,set_fields:{name:'new'},unset_fields:['info']};
  assert.equal(valid('nodered_admin_prepare',{...args(),edits:[patch]}),true);
  assert.equal(valid('nodered_admin_prepare',{...args(),edits:[{...patch,arbitrary:true}]}),false);
  assert.equal(valid('nodered_admin_prepare',{...args(),edits:[{...patch,set_fields:JSON.parse('{"__proto__":"x"}')}]}),false);
});
test('read pagination uses exact SHA after first page',()=>{
  const read={host:'raspberry',view:'runtime',operation_id:null,node_id:null,field:null,offset:0,expected_sha256:null};
  assert.equal(valid('nodered_admin_read',read),true);
  assert.equal(valid('nodered_admin_read',{...read,offset:16}),false);
  assert.equal(valid('nodered_admin_read',{...read,offset:7,expected_sha256:sha}),true);
  assert.equal(valid('nodered_admin_read',{...read,limit:32}),false);
  assert.equal(valid('nodered_admin_read',{...read,offset:9999,expected_sha256:sha}),true);
  assert.equal(valid('nodered_admin_read',{...read,offset:10000,expected_sha256:sha}),false);
  assert.equal(valid('nodered_admin_read',{...read,operation_id:id}),false);
  assert.equal(valid('nodered_admin_read',{...read,view:'other'}),false);
});
test('plan_diff uses exact operation and byte offsets with plan SHA after bootstrap',()=>{
  const read={host:'raspberry',view:'plan_diff',operation_id:id,node_id:null,field:null,offset:0,expected_sha256:null};
  assert.equal(valid('nodered_admin_read',read),true);
  assert.equal(valid('nodered_admin_read',{...read,operation_id:null}),false);
  assert.equal(valid('nodered_admin_read',{...read,offset:8191}),false);
  assert.equal(valid('nodered_admin_read',{...read,offset:8191,expected_sha256:sha}),true);
  assert.equal(valid('nodered_admin_read',{...read,offset:1048576,expected_sha256:sha}),true);
  assert.equal(valid('nodered_admin_read',{...read,offset:1048577,expected_sha256:sha}),false);
});
test('node_field bootstrap requires exact safe node and field with null operation',()=>{
  const read={host:'raspberry',view:'node_field',operation_id:null,node_id:'node__canonical.1',field:'func',offset:0,expected_sha256:null};
  assert.equal(valid('nodered_admin_read',read),true);
  assert.equal(valid('nodered_admin_read',{...read,operation_id:id}),false);
  assert.equal(valid('nodered_admin_read',{...read,node_id:null}),false);
  assert.equal(valid('nodered_admin_read',{...read,field:null}),false);
});
test('node_field byte pagination requires snapshot node SHA after first page',()=>{
  const read={host:'raspberry',view:'node_field',operation_id:null,node_id:'node__canonical.1',field:'func',offset:8191,expected_sha256:sha};
  assert.equal(valid('nodered_admin_read',read),true);
  assert.equal(valid('nodered_admin_read',{...read,expected_sha256:null}),false);
  assert.equal(valid('nodered_admin_read',{...read,offset:1048577}),false);
});
test('read rejects mixed views, arbitrary fields and prototype traversal',()=>{
  const read={host:'raspberry',view:'node_field',operation_id:null,node_id:'node__canonical.1',field:'func',offset:0,expected_sha256:null};
  for(const field of ['../secret','x.y','__proto__','constructor'])assert.equal(valid('nodered_admin_read',{...read,field}),false);
  assert.equal(valid('nodered_admin_read',{...read,view:'runtime'}),false);
  assert.equal(valid('nodered_admin_read',{...read,view:'plan_diff',operation_id:id}),false);
});
test('large prepare accepted below 1 MiB and all other large frames refused',()=>{
  const large=args();large.edits[0].node.info='x'.repeat(32768);
  const b=bytes(q('nodered_admin_prepare',large));assert.ok(b.length>LEGACY_LIMIT);
  assert.equal(new FrameParser().push(b).length,1);
  assert.throws(()=>new FrameParser().push(bytes(q('project_read',{...large}))),/legacy_request_limit/);
  assert.throws(()=>new FrameParser().push(bytes(q('nodered_admin_validate',{...large}))),/legacy_request_limit/);
  assert.throws(()=>new FrameParser().push(bytes(q('nodered_admin_prepare',{...large,extra:true}))),/legacy_request_limit/);
});
test('prepare hard limit and partial stream are bounded',()=>{
  const parser=new FrameParser();assert.deepEqual(parser.push(Buffer.from('{')),[]);
  assert.throws(()=>parser.end(),/incomplete_request/);
  assert.throws(()=>parser.push(Buffer.alloc(PREPARE_LIMIT)),/request_limit/);
  const b=bytes(q()), split=new FrameParser();assert.deepEqual(split.push(b.subarray(0,8)),[]);
  assert.equal(split.push(b.subarray(8)).length,1);split.end();
});
test('legacy envelope is passed unchanged and its 16 KiB limit preserved',async()=>{
  const request={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ha_notifications',arguments:{host:'raspberry'}}};
  let actual;const route=makeAdminRoute(async x=>{actual=x;return {legacy:true};},()=>assert.fail('admin broker called'));
  const parsed=new FrameParser().push(bytes(request))[0].request;
  assert.deepEqual(await route(parsed),{legacy:true});assert.deepEqual(actual,request);
  const over={...request,params:{...request.params,arguments:{host:'raspberry',payload:'x'.repeat(LEGACY_LIMIT)}}};
  assert.throws(()=>new FrameParser().push(bytes(over)),/legacy_request_limit/);
});
test('events, notices and all other existing descriptors preserved',async()=>{
  const existing=[{name:'events_status',annotations:{readOnlyHint:true}},{name:'ha_notifications',inputSchema:{type:'object'}}];
  const route=makeAdminRoute(async()=>({result:{tools:structuredClone(existing)}}));
  const result=await route({method:'tools/list'});
  assert.deepEqual(result.result.tools.slice(0,2),existing);assert.equal(result.result.tools.length,11);
});
test('admin parameters never reach legacy and logs contain only allowed fields',async()=>{
  let called=0;const rows=[];const route=makeAdminRoute(()=>assert.fail('legacy called'),async params=>{called++;assert.equal(params.arguments.operation_id,id);return {state:'prepared'};},row=>rows.push(row));
  assert.equal((await route(q())).result.structuredContent.state,'prepared');
  assert.equal(called,1);for(const row of rows)assert.deepEqual(Object.keys(row).sort(),['id','success','tool']);
  assert.equal((await route(q('nodered_admin_prepare',{...args(),shell:'x'}))).result.isError,true);
  assert.equal(called,1);
});
test('rollback prepares a distinct operation; status never retries effects',async()=>{
  assert.equal(valid('nodered_admin_rollback',{host:'raspberry',operation_id:id,rollback_operation_id:id}),false);
  assert.equal(valid('nodered_admin_rollback',{host:'raspberry',operation_id:id,rollback_operation_id:'c'.repeat(32)}),true);
  let calls=0;const route=makeAdminRoute(()=>assert.fail(),async()=>{calls++;throw Error('outcome_unknown');});
  assert.equal((await route(q())).result.isError,true);assert.equal(calls,1);
});
test('rate cap 60 per minute and 64 KiB response cap',()=>{
  let now=0;const parser=new FrameParser({now:()=>now});
  for(let i=0;i<60;i++)assert.equal(parser.push(bytes({id:i})).length,1);
  assert.throws(()=>parser.push(bytes({id:61})),/request_rate_limit/);
  now=60000;assert.equal(parser.push(bytes({id:62})).length,1);
  assert.throws(()=>encodeResponse({data:'x'.repeat(65536)}),/response_limit/);
});
test('admin response cap does not alter large notices or events encoding',()=>{
  const response={jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:'x'.repeat(70000)}]}};
  for(const name of ['ha_notifications','events_status']) {
    const request=q(name,{host:'raspberry'});
    assert.equal(encodeRoutedResponse(request,response),JSON.stringify(response)+'\n');
    assert.ok(Buffer.byteLength(encodeRoutedResponse(request,response))>65536);
  }
  assert.throws(()=>encodeRoutedResponse(q(),response),/response_limit/);
});

// PRIVACY_TEST_FIXTURE: metadata only, no real socket or runtime calls.
test('Root private socket identity is checked before writing a request',async()=>{
 const {checkedSocket}=await import('./nodered-admin-route.mjs');
 const parent={uid:1001,gid:985,mode:0o750,isDirectory:()=>true,isSymbolicLink:()=>false};
 const entry={uid:0,gid:985,mode:0o660,dev:1,ino:2,isSocket:()=>true,isSymbolicLink:()=>false};
 assert.equal(checkedSocket(p=>p.endsWith('.sock')?entry:parent).ino,2);
 assert.throws(()=>checkedSocket(p=>p.endsWith('.sock')?{...entry,uid:1001}:parent));
});
