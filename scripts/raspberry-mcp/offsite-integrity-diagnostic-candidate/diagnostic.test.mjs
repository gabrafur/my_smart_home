import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
test("crypto failure projection uses only closed sanitized envelopes",()=>{
 const r=spawnSync("python3",["-I","-S","-B","-m","unittest","discover","-s",fileURLToPath(new URL("./",import.meta.url)),"-p","test_crypto_diagnostic.py"],{encoding:"utf8",timeout:10000,maxBuffer:32768});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Ran 6 tests/);
});
