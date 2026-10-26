import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("candidate component reader, projections and ledger stay isolated", () => {
 const r=spawnSync("python3",["-I","-S","-B","-m","unittest","discover","-s",fileURLToPath(new URL("./",import.meta.url)),"-p","test_*.py"],{encoding:"utf8",timeout:30000,maxBuffer:128*1024});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Ran [1-9]\d* tests/);
});
test("candidate deployed-configuration identity rejects material changes",()=>{
 const r=spawnSync(process.execPath,["--test","--test-concurrency=1",fileURLToPath(new URL("./attestation_model.test.cjs",import.meta.url))],{encoding:"utf8",timeout:30000,maxBuffer:128*1024});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);
});
