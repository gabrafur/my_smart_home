import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const generator=fileURLToPath(new URL('../nodered/tools/install-internet-monitor-flow.mjs',import.meta.url));
const canonical=JSON.parse(fs.readFileSync(new URL('../nodered/flows.json',import.meta.url),'utf8'));
const functions=['internet_remote_access_report_ingest','internet_remote_facts_read'];
const replays=['internet_test_codex_absent','internet_test_codex_ready'];

function fixture(){
 const flows=structuredClone(canonical);
 for(const node of flows){
  if(functions.includes(node.id))node.func='return msg;';
  if(replays.includes(node.id)){
   const prop=node.props.find(p=>p.p==='payload'),value=JSON.parse(prop.v);
   value.schema_version=1;delete value.services.codex_remote.listener_state;prop.v=JSON.stringify(value);
  }
 }
 return flows;
}

function isolated(run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-refresh-'));
 try{run(path.join(dir,'flows.json'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test('scoped regeneration updates only source and replay fields and is idempotent',()=>isolated(file=>{
 const input=fixture();fs.writeFileSync(file,JSON.stringify(input));
 const execute=()=>spawnSync(process.execPath,[generator,file,file,'--refresh-remote-report'],{encoding:'utf8',timeout:10000});
 assert.equal(execute().status,0);
 const after=JSON.parse(fs.readFileSync(file)),byId=new Map(after.map(n=>[n.id,n]));
 assert.equal(after.length,input.length);
 for(const before of input){
  const next=structuredClone(byId.get(before.id)),prior=structuredClone(before);
  if(functions.includes(before.id)){assert.notEqual(next.func,prior.func);delete next.func;delete prior.func;}
  if(replays.includes(before.id)){assert.notDeepEqual(next.props,prior.props);delete next.props;delete prior.props;}
  assert.deepEqual(next,prior,`unrelated field changed in ${before.id}`);
 }
 const first=fs.readFileSync(file);assert.equal(execute().status,0);assert.deepEqual(fs.readFileSync(file),first);
}));

test('missing required node or non-test replay fails without writing',()=>{
 for(const alter of [flows=>flows.filter(n=>n.id!==functions[0]),flows=>{
  const n=flows.find(n=>n.id===replays[0]),prop=n.props.find(p=>p.p==='payload');
  const value=JSON.parse(prop.v);value.test_mode=false;prop.v=JSON.stringify(value);return flows;
 }])isolated(file=>{
  const before=JSON.stringify(alter(fixture()));fs.writeFileSync(file,before);
  const result=spawnSync(process.execPath,[generator,file,file,'--refresh-remote-report'],{encoding:'utf8',timeout:10000});
  assert.notEqual(result.status,0);assert.equal(fs.readFileSync(file,'utf8'),before);
 });
});
