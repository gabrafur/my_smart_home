import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('reviewed operations reply preserves JSON semantics within the socket bound',()=>{
 const file=fileURLToPath(new URL('./read-catalog-release/test_wire_reply.py',import.meta.url));
 const result=spawnSync('python3',['-I','-S','-B',file],{encoding:'utf8',timeout:10000,maxBuffer:16384});
 assert.equal(result.error,undefined);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/Ran 2 tests/);
});
