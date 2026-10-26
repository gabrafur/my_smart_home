import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync}from 'node:child_process';import {fileURLToPath}from 'node:url';
const root=fileURLToPath(new URL('./',import.meta.url));
test('loaded iCloud contract, natural attempts and recovery: 77 isolated cases',()=>{const r=spawnSync('/usr/bin/python3',['-I','-S','-B','-m','unittest','discover','-s',root,'-p','test_*.py'],{encoding:'utf8',timeout:15000,maxBuffer:65536});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Ran 77 tests/);});
