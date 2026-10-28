import test from 'node:test';
import assert from 'node:assert/strict';
import {executeCommand} from './consumer_cli.mjs';
import {StoreInvalid} from './consumer_store.mjs';

test('invalid commands and roles cannot open stores or activate fallback',()=>{
 for(const [argv,identity]of [
  [['prepare','invalid'],{uid:1000,gid:1000}],[['prepare','x','y'],{uid:1000,gid:1000}],
  [['commit'],{uid:1000,gid:1000}],[['snapshot','x'],{uid:1000,gid:1000}],
  [['checkpoint-prepare','x'],{uid:1000,gid:1000}],[['arbitrary'],{uid:1000,gid:1000}],
  [['prepare'],{uid:0,gid:1000}],[['prepare'],{uid:1000,gid:0}],
 ]){
  const opened=[];
  const result=executeCommand(argv,{...identity,open(only){opened.push(only);throw new StoreInvalid('unexpected_open');}});
  assert.equal(result.exitCode,1);assert.equal(result.value.state,'unknown');assert.equal(result.value.checkpoint_only,null);
  assert.deepEqual(opened,[],'invalid request must not open any store');
 }
});
test('only a valid failed source prepare may return a handled own-history envelope',()=>{
 const opened=[],closed=[],own={state:'checkpoint_prepared',synthetic:true};
 const result=executeCommand(['prepare'],{uid:1000,gid:1000,open(only){
  opened.push(only);
  if(!only)throw new StoreInvalid('consumer_open_failed');
  return {prepareCheckpoint(){return own;},close(){closed.push(true);}};
 }});
 assert.equal(result.exitCode,0);assert.equal(result.value.state,'unknown');
 assert.equal(result.value.collection_error,'consumer_open_failed');assert.deepEqual(result.value.checkpoint_only,own);
 assert.equal(result.value.full24h_proven,false);assert.deepEqual(opened,[false,true]);assert.equal(closed.length,1);
});
test('missing own history remains an unhandled unknown without initialization',()=>{
 const opened=[];
 const result=executeCommand(['prepare'],{uid:1000,gid:1000,open(only){
  opened.push(only);throw new StoreInvalid(only?'consumer_history_missing':'consumer_open_failed');
 }});
 assert.equal(result.exitCode,1);assert.equal(result.value.checkpoint_only,null);assert.deepEqual(opened,[false,true]);
});
test('producer commit failure never falls back to a different write operation',()=>{
 const opened=[];
 const result=executeCommand(['commit','a'.repeat(64)],{uid:1000,gid:1000,open(only){
  opened.push(only);throw new StoreInvalid('consumer_open_failed');
 }});
 assert.equal(result.exitCode,1);assert.equal(result.value.checkpoint_only,null);assert.deepEqual(opened,[false]);
});
