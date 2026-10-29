import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync}from 'node:child_process';import {fileURLToPath}from 'node:url';
test('reviewed Codex socket replacement preserves all authority and dependency chains',()=>{
 const suite=fileURLToPath(new URL('./runtime-source/administrative-recovery/',import.meta.url));
 const r=spawnSync('python3',['-I','-S','-B','-m','unittest','discover','-s',suite,'-p','test_control_binding_review.py'],{encoding:'utf8',timeout:10000,maxBuffer:32768});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Ran 7 tests/);
});
