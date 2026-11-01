// Trusted synthetic bodies only. This is not a native Node-RED execution test.
const assert=require('node:assert/strict');
const test=require('node:test');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const rows=func=>[{id:'host_obs_test_build',type:'function',z:'host_observer_tab',func}];
const before='if(msg._host_observer_test!==true)return null;flow.set("fixture__test",undefined);node.status({fill:"blue"});return null;';
const after='if(msg._host_observer_test!==true)return null;flow.set("fixture__test",undefined);return null;';
const probe=async value=>(await import(pathToFileURL(path.join(__dirname,'functional_probe.mjs')))).probeReset(value);
test('before defect and corrected exact function remain distinct',async()=>{
 const a=await probe(rows(before)),b=await probe(rows(after));
 assert.equal(a.status_callbacks,1);assert.equal(a.passed,false);assert.equal(b.status_callbacks,0);assert.equal(b.passed,true);
 assert.notEqual(a.function_sha256,b.function_sha256);
});
test('passing isolated behavior keeps native and physical coverage unknown',async()=>{
 const p=await probe(rows(after));assert.equal(p.native_full_flow_replay,false);assert.equal(p.physical_health,'unknown');
 assert.deepEqual(p.coverage,['host_observer_test_reset_status_isolation']);
});
test('production context writes invalidate the receipt',async()=>{
 await assert.rejects(probe(rows('flow.set("production",1);return null;')));
});
test('direct output effects invalidate the receipt',async()=>{
 await assert.rejects(probe(rows('node.send({});return null;')));
});
test('missing or different node classes never produce a matching proof',async()=>{
 await assert.rejects(probe([]));await assert.rejects(probe([{id:'host_obs_test_build',type:'exec',z:'host_observer_tab'}]));
});
