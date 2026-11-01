import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('./runtime-source/component-repair/',import.meta.url));
test('installed component reference has portable synthetic lifecycle and source tests',()=>{
 const r=spawnSync('python3',['-I','-S','-B','-m','unittest','discover','-s',directory,'-p','test_*.py'],{encoding:'utf8',timeout:30000,maxBuffer:131072});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);const match=r.stderr.match(/Ran (\d+) tests?/);assert.ok(match,r.stderr);assert.ok(Number(match[1])>=57,r.stderr);
});
for(const [name,file]of[['readonly session and unknown revocation','readonly-observer.test.cjs'],['kernel lock and publication contract','publication-contract.test.cjs'],['isolated exact function coverage','harness/functional-probe.test.cjs']])test(name,()=>{
 const r=spawnSync(process.execPath,['--test','--test-concurrency=1',directory+file],{encoding:'utf8',timeout:15000,maxBuffer:65536});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);
});
test('source lineage and public disarming are explicit without native reads',()=>{
 const map=JSON.parse(fs.readFileSync(new URL('./runtime-source/SOURCE-MAP.json',import.meta.url)));
 const entries=Object.entries(map.files).filter(([name])=>name.startsWith('component-repair/'));
 assert.equal(entries.length,30);
 for(const [name,row]of entries){
  const data=fs.readFileSync(new URL('./runtime-source/'+name,import.meta.url));
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'),row.export_sha256);
  assert.equal(row.native_source_matches_frozen_candidate,true);assert.equal(row.native_owner_uid,0);
  assert.ok(['0644','0444'].includes(row.native_mode));
 }
 const source=file=>fs.readFileSync(directory+file,'utf8');
 assert.match(source('root_bootstrap.py'),/^END=0 /m);
 assert.ok(source('publication_bridge.cjs').includes('Math.min(0,Date.now()/1000+86400)'));
 assert.ok(source('native_factory.py').includes("'host':'<NODE_RED_PEER>'"));
 assert.ok(!entries.some(([name])=>name.endsWith('policy.json')||name.includes('/public-snapshot/')));
});
