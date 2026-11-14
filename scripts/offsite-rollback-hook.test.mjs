import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runRollbackCloudContinuation} from './offsite-rollback-hook.mjs';
function fixture(callback) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rollback-hook-'));
  fs.mkdirSync(path.join(root,'.local-secrets'));
  try { return callback(root); }
  finally { fs.rmSync(root,{recursive:true,force:true}); }
}
test('missing policy never dispatches',()=>fixture(root=>{
  assert.deepEqual(runRollbackCloudContinuation({root,run(){assert.fail('unexpected dispatch');}}),{state:'not_configured',retired:0});
}));
test('configured policy uses only the fixed entry point',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'.local-secrets/rollback-cloud-daily.json'),'{}');
  const result=runRollbackCloudContinuation({root,run(command,args,options){
    assert.equal(command,'/usr/bin/python3');
    assert.deepEqual(args,['-I','-S','-B',path.join(root,'scripts/rollback_cloud_daily.py')]);
    assert.equal(options.cwd,root);
    return {status:0,stdout:JSON.stringify({state:'observed',retired:2,compressed_bytes:123,blocked:[]})};
  }});
  assert.equal(result.retired,2);
}));
test('uncertain child result never retries',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'.local-secrets/rollback-cloud-daily.json'),'{}');
  let calls=0;
  const result=runRollbackCloudContinuation({root,run(){calls++;return {status:1};}});
  assert.equal(calls,1);assert.equal(result.state,'uncertain');assert.equal(result.automatic_retry,false);
}));
test('invalid output cannot declare retirement',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'.local-secrets/rollback-cloud-daily.json'),'{}');
  const result=runRollbackCloudContinuation({root,run(){return {status:0,stdout:'{"state":"observed","retired":3}'};}});
  assert.equal(result.state,'uncertain');assert.equal(result.retired,0);
}));
test('blocked reason remains sanitized',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'.local-secrets/rollback-cloud-daily.json'),'{}');
  const result=runRollbackCloudContinuation({root,run(){return {status:0,stdout:JSON.stringify({state:'blocked',retired:0,reason:'private /path password'})};}});
  assert.equal(result.reason,'none');
}));
