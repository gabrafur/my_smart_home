import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for(const pattern of ['test_operating_policy.py','test_workspace_legacy_gate.py']){
 test(`workspace authority preserves independent admission: ${pattern}`,()=>{
  const result=spawnSync('python3',['-I','-S','-B','-m','unittest','discover','-s',
   fileURLToPath(new URL('./runtime-source/repair-control/',import.meta.url)),'-p',pattern],
   {encoding:'utf8',timeout:10000,maxBuffer:65536});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 });
}
