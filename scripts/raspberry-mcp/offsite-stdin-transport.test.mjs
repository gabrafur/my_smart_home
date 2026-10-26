import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('./runtime-source/offsite-integrity/',import.meta.url));
for(const [pattern,count]of [['test_verify.py',10],['test_key_reader.py',8],['test_crypto_diagnostic.py',6],['test_recovery_guard.py',6],['test_activate.py',3]])test('offline backup verification '+pattern,()=>{
 const r=spawnSync('/usr/bin/python3',['-I','-S','-B','-m','unittest','discover','-s',directory,'-p',pattern],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stderr,new RegExp('Ran '+count+' tests'));
});
test('fixed backup selection remains read-only on synthetic inventory',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./runtime-source/offsite-integrity/test_download.cjs',import.meta.url))],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{selector_cases:10,passed:true,network_called:false,credentials_read:false});
});
