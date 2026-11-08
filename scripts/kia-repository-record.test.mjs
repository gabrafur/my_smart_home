import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {kiaRepositoryRecordCode,requireLegacyInstallationRecord} from './kia-repository-record.mjs';
const name='Hyundai-Kia-Connect/kia_uvo';
function read(t, native, legacy) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kia-registry-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [file,value] of [['marketplace.repositories',native],['hacs.repositories',legacy]]) {
    if(value!==undefined) fs.writeFileSync(path.join(root,file),typeof value==='string'?value:JSON.stringify(value));
  }
  return spawnSync('python3',['-c',kiaRepositoryRecordCode.replaceAll('/config/.storage/',root+'/')],{encoding:'utf8',timeout:3000});
}
const registry=version=>({data:{'12':{full_name:name,installed:true,version_installed:version,password:'not-for-output'},'13':{full_name:'other/integration',private:'not-for-output'}}});
test('native registry wins and only selected fields leave producer',t=>{
  const r=read(t,registry('v3.22.0'),registry('v1.0.0'));assert.equal(r.status,0);
  const v=JSON.parse(r.stdout);assert.equal(v.version_installed,'v3.22.0');assert.equal(v.repository_source,'marketplace');assert.doesNotMatch(r.stdout,/not-for-output|other\/integration/);
});
test('legacy fallback only when native is absent',t=>{
  const r=read(t,undefined,registry('v3.20.0'));assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).repository_source,'hacs');
});
test('missing native record never resurrects stale legacy identity',t=>{
  const r=read(t,{data:{}},registry('v3.20.0'));assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout),null);
});
for(const [title,value] of [['malformed','{'],['wrong shape',{data:[]}],['duplicate',{data:{a:{full_name:name},b:{full_name:name}}}]]) {
  test(`${title} native registry fails closed`,t=>{assert.notEqual(read(t,value,registry('v3.20.0')).status,0);});
}
test('both missing is an explicit collection error',t=>{assert.notEqual(read(t).status,0);});
test('native installation cannot use legacy shared-registry rollback',()=>{
  assert.throws(()=>requireLegacyInstallationRecord({repository_source:'marketplace'}),/reviewed_adapter/);
  assert.throws(()=>requireLegacyInstallationRecord(null));
  assert.doesNotThrow(()=>requireLegacyInstallationRecord({repository_source:'hacs'}));
});
