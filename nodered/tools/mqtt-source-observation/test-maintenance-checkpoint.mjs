import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {canonical,digest,schema,zeroCounts} from './consumer_protocol.mjs';
import {transition} from './consumer_state.mjs';
import {violations} from './canvas_checkpoint.mjs';
import {inspectCheckpoint} from './maintenance_checkpoint.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./synthetic-protocol-fixture.json',import.meta.url)));
function valid(){
 const first=transition(null,canonical(fixture.first)).state;
 const state=transition(first,canonical(fixture.done)).state;
 const c={schema_version:2,sequence:'1',previous_sha256:null,proposal_sha:'a'.repeat(64),receipt_id:state.last_receipt,
  acknowledged_counts_sha256:digest(state.acked_counts),reader_observation:null,window_request:null,history:[],
  window:{id_sha256:'b'.repeat(64),phase:'tracking',reason:'collecting',clock_domain_sha256:'d'.repeat(64),
   started_at_ns:'100',observed_at_ns:'200',first_receipt_id:'0',last_receipt_id:state.last_receipt,
   baseline_counts:zeroCounts(),acknowledged_counts:state.acked_counts,
   max_upper_ns_by_kind:Object.fromEntries(schema.kinds.map(k=>[k,null])),
   violations:Object.fromEntries(violations.map(k=>[k,'0'])),
   policy:{event_latency_ms:'10000',window_duration_ns:'86400000000000'},cut:null}};
 Object.assign(state,{version:2,canvas_checkpoint:c});return {schema_version:1,body:state,sha256:digest(state)};
}
test('stopped snapshot uses the existing state and checkpoint validators',()=>{
 const v=valid(),raw=Buffer.from(canonical(v));const before=Buffer.from(raw);
 assert.deepEqual(inspectCheckpoint(raw),{acked_counts:v.body.acked_counts,canvas_checkpoint:v.body.canvas_checkpoint});
 assert.deepEqual(raw,before);
});
test('a self-consistent envelope cannot hide a changed checkpoint anchor',()=>{
 const v=valid();v.body.canvas_checkpoint.acknowledged_counts_sha256='f'.repeat(64);v.sha256=digest(v.body);
 assert.throws(()=>inspectCheckpoint(Buffer.from(canonical(v))));
});
test('missing, corrupt, noncanonical and oversized checkpoints stay unknown',()=>{
 const v=valid();
 for(const raw of [Buffer.from('{}'),Buffer.from(canonical(v)+' '),Buffer.alloc(131073),
  Buffer.from(canonical({...v,sha256:'0'.repeat(64)})),Buffer.from(canonical({...v,extra:'PRIVATE_CANARY'}))]){
  assert.throws(()=>inspectCheckpoint(raw));
 }
});
test('unmigrated state is not silently upgraded',()=>{
 const v=valid();delete v.body.canvas_checkpoint;v.body.version=1;v.sha256=digest(v.body);
 assert.throws(()=>inspectCheckpoint(Buffer.from(canonical(v))));
});
test('CLI emits only validated metadata from stdin and writes no state',()=>{
 const v=valid(),r=spawnSync(process.execPath,[new URL('./maintenance_checkpoint.mjs',import.meta.url).pathname],
  {input:canonical(v),encoding:'utf8'});
 assert.equal(r.status,0);assert.equal(r.stderr,'');assert.equal(JSON.parse(r.stdout).state,'validated_stopped_consumer_checkpoint');
 assert.deepEqual(JSON.parse(r.stdout).accounting.acked_counts,v.body.acked_counts);
});
test('CLI rejects arguments and never echoes invalid input',()=>{
 for(const args of [[],['/arbitrary/path']]){
  const r=spawnSync(process.execPath,[new URL('./maintenance_checkpoint.mjs',import.meta.url).pathname,...args],
   {input:'PRIVATE_CANARY',encoding:'utf8'});
  assert.equal(r.status,1);assert(!r.stdout.includes('PRIVATE_CANARY'));assert.equal(r.stderr,'');
  assert.equal(JSON.parse(r.stdout).collection_error,'maintenance_checkpoint_invalid');
 }
});
