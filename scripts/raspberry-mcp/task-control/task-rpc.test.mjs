import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {descriptors} from './task-tools.mjs';

// Exercise the actual RPC implementation with a synthetic daemon, without the
// installed transport/vendor dependency or any access to production data.
const module = {exports:{}};
const source = fs.readFileSync(new URL('./task_rpc.cjs', import.meta.url), 'utf8');
vm.runInNewContext(source, {module,require:path=>{
  if(path.endsWith('/ws'))return {};
  if(path.endsWith('/codex_control_rpc.cjs'))return {
    metadata(t,id){
      assert.equal(t.id,id);
      assert.ok(['idle','notLoaded','active','systemError'].includes(t.status.type));
      return {thread_id:id,status:t.status.type,cwd_is_project:t.cwd==='/mnt/data/docker',can_accept_direct_input:t.canAcceptDirectInput===true};
    }, quota(){},
  };
  throw Error('unexpected import');
}});
const {run} = module.exports;
const id='00000000-0000-0000-0000-000000000001';
const thread={id,cwd:'/mnt/data/docker',ephemeral:false,path:'/synthetic',status:{type:'idle'},canAcceptDirectInput:true,source:'vscode',createdAt:1,updatedAt:2,name:'PRIVATE',preview:'PRIVATE'};
const profile={cwd:'/mnt/data/docker',approvalPolicy:'never',modelProvider:'openai',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[]}};

test('confirmed creation with incompatible profile remains blocked',async()=>{
  const calls=[];
  const result=await run({mode:'creation_probe',thread_id:id},async(method)=>{
    calls.push(method);
    return {thread,...profile,sandbox:{type:'dangerFullAccess'}};
  });
  assert.equal(result.state,'durable_blocked');
  assert.equal(result.reason,'profile_mismatch');
  assert.deepEqual(calls,['thread/read','thread/resume']);
});
test('compatible creation is ready; native busy state is separate',async()=>{
  const ready=await run({mode:'creation_probe',thread_id:id},async()=>({thread,...profile}));
  assert.equal(ready.state,'durable_ready');
  const busy=await run({mode:'creation_probe',thread_id:id},async()=>({thread:{...thread,status:{type:'active'}},...profile}));
  assert.equal(busy.state,'durable_blocked');assert.equal(busy.reason,'thread_not_ready');
});
test('uncertain read never resumes or recreates a thread',async()=>{
  const calls=[];
  const result=await run({mode:'creation_probe',thread_id:id},async method=>{
    calls.push(method);throw Error('PRIVATE');
  });
  assert.equal(result.state,'unconfirmed');assert.deepEqual(calls,['thread/read']);
});
test('listing metadata uses read-only RPCs and withholds native text',async()=>{
  const calls=[];
  const result=await run({mode:'metadata',thread_id:id},async(method,params)=>{
    calls.push(method);
    if(method==='thread/read'){
      assert.equal(params.includeTurns,false);
      return {thread:{...thread,status:{type:'notLoaded'}}};
    }
    assert.equal(method,'thread/turns/list');assert.equal(params.itemsView,'notLoaded');
    return {data:[],nextCursor:null};
  });
  assert.equal(result.state,'notLoaded');assert.equal(result.last_execution,null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual(calls,['thread/read','thread/turns/list']);
});
test('turn collection failure remains explicit and nonterminal',async()=>{
  const result=await run({mode:'metadata',thread_id:id},async method=>{
    if(method==='thread/read')return {thread};throw Error('PRIVATE');
  });
  assert.equal(result.collection_error,'turn_collection_failed');assert.equal(result.last_execution,null);
});
test('metadata rejects changed identity or project',async()=>{
  await assert.rejects(run({mode:'metadata',thread_id:id},async()=>({thread:{...thread,cwd:'/other'}})));
  await assert.rejects(run({mode:'metadata',thread_id:id,command:'no'},()=>assert.fail('RPC before validation')));
});
test('MCP schema is strict and listing is read-only',()=>{
  const descriptor=descriptors.find(t=>t.name==='codex_threads_list');
  assert.equal(descriptor.annotations.readOnlyHint,true);
  assert.equal(descriptor.annotations.destructiveHint,false);
  assert.equal(descriptor.inputSchema.additionalProperties,false);
  assert.deepEqual(descriptor.inputSchema.required,['host','limit','cursor']);
  assert.deepEqual(descriptor.inputSchema.properties.host.enum,['raspberry']);
  assert.equal(descriptor.inputSchema.properties.limit.maximum,50);
});
test('durable coordinator and catalog Python regressions',()=>{
  const result=spawnSync('python3',['-B','-m','unittest','discover','-s',
    fileURLToPath(new URL('.',import.meta.url)),'-p','test_*.py'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
