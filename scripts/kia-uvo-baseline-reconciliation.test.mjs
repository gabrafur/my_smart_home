import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {inventoryBaseline,validateAttestation,currentBaselineReconciled,readRuntimeManifest} from './kia-uvo-baseline-reconciliation.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const previousRaw=JSON.stringify({state:'failed',source_commit:'a'.repeat(40)});
const candidate={commit:'b'.repeat(40),target:'v3.21.0'};
function fixture(){
 const files={'manifest.json':sha('fixture')},hacs={installed:true,installed_commit:'c'.repeat(7),version_installed:'v3.19.0'};
 const context={previousRaw,candidate,files,hacs,manifestVersion:'3.19.0',projectIdentity:sha('project'),now:100};
 const v={schema_version:1,kind:'current_baseline_verified_before_different_candidate',operation_id:'d'.repeat(32),
  issued_at:90,expires_at:110,previous_receipt_sha256:sha(previousRaw),previous_source_commit:'a'.repeat(40),
  candidate_commit:candidate.commit,target_version:'3.21.0',baseline_version:'3.19.0',baseline_files:files,
  hacs_installed:true,hacs_installed_commit:hacs.installed_commit,project_identity_sha256:context.projectIdentity,
  historical_outcome:'unknown_preserved',historical_cause_known:false};
 return {v,context};
}
test('exact baseline permits a different candidate without asserting historical outcome',()=>{
 const {v,context}=fixture();assert.equal(validateAttestation(v,context),true);
});
for(const [name,mutate] of Object.entries({
 extra: v=>v.unreviewed=true,missing:v=>delete v.historical_cause_known,
 expired:v=>v.expires_at=100,future:v=>v.issued_at=101,long_lease:v=>v.expires_at=86501,
 old_receipt:v=>v.previous_receipt_sha256='e'.repeat(64),old_commit:v=>v.previous_source_commit='f'.repeat(40),
 same_candidate:v=>v.candidate_commit='a'.repeat(40),different_candidate:v=>v.candidate_commit='f'.repeat(40),
 target:v=>v.target_version='3.22.0',baseline:v=>v.baseline_version='3.21.0',
 tree:v=>v.baseline_files={'manifest.json':sha('changed')},hacs:v=>v.hacs_installed=false,
 hacs_commit:v=>v.hacs_installed_commit='e'.repeat(7),project:v=>v.project_identity_sha256='e'.repeat(64),
 invented_outcome:v=>v.historical_outcome='success',invented_cause:v=>v.historical_cause_known=true,
})){test('rejects attestation drift: '+name,()=>{const {v,context}=fixture();mutate(v);assert.equal(validateAttestation(v,context),false);});}
for(const [name,mutate] of Object.entries({
 receipt:c=>c.previousRaw+=' ',pending:c=>c.previousRaw=JSON.stringify({state:'applying',source_commit:'a'.repeat(40)}),
 hacs:c=>c.hacs.installed=false,version:c=>c.hacs.version_installed='v3.18.0',
 loader:c=>c.manifestVersion='3.20.0',files:c=>c.files={},project:c=>c.projectIdentity=sha('other'),
})){test('rejects current observation drift: '+name,()=>{const {v,context}=fixture();mutate(context);assert.equal(validateAttestation(v,context),false);});}
test('bounded inventory hashes source, excludes bytecode, and rejects symlinks, hardlinks and oversized files',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kia-baseline-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'manifest.json'),'fixture');fs.mkdirSync(path.join(dir,'__pycache__'));
 fs.writeFileSync(path.join(dir,'__pycache__/ignored.pyc'),'ignored');
 assert.deepEqual(inventoryBaseline(dir),{'manifest.json':sha('fixture')});
 const bad=path.join(dir,'bad');fs.symlinkSync('manifest.json',bad);assert.throws(()=>inventoryBaseline(dir));fs.unlinkSync(bad);
 fs.linkSync(path.join(dir,'manifest.json'),bad);assert.throws(()=>inventoryBaseline(dir));fs.unlinkSync(bad);
 fs.writeFileSync(bad,Buffer.alloc(262145));assert.throws(()=>inventoryBaseline(dir));
});
test('untrusted or mismatched attestation cannot read archive, token or runtime',async()=>{
 let calls=0;const deny=()=>{calls++;throw Error('unexpected');};
 const result=await currentBaselineReconciled({repoRoot:process.cwd(),previousRaw,candidate,readToken:deny,
  readAttestation:()=>fixture().v,readArchive:deny,readHacs:deny,readManifest:deny,now:100});
 assert.equal(result,false);assert.equal(calls,0);
});
test('archive and actual source are independently required before any token read',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kia-current-baseline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const component=path.join(dir,'homeassistant/custom_components/kia_uvo');fs.mkdirSync(component,{recursive:true});fs.writeFileSync(path.join(component,'manifest.json'),'fixture');
 const {v,context}=fixture();v.project_identity_sha256=sha(fs.realpathSync(dir));let tokens=0;
 const args={repoRoot:dir,previousRaw,candidate,readAttestation:()=>v,readToken:()=>{tokens++;return 'synthetic';},
  readArchive:()=>true,readHacs:()=>context.hacs,readManifest:async()=>context.manifestVersion,now:100};
 assert.equal(await currentBaselineReconciled({...args,readArchive:()=>false}),false);assert.equal(tokens,0);
 assert.equal(await currentBaselineReconciled(args),true);assert.equal(tokens,1);
 fs.writeFileSync(path.join(component,'manifest.json'),'changed');assert.equal(await currentBaselineReconciled(args),false);
});
function socketClass(mode){return class extends EventEmitter{
 constructor(url,options){super();assert.equal(url,'ws://127.0.0.1:8123/api/websocket');assert.equal(options.maxPayload,65536);
  queueMicrotask(()=>this.emit(mode==='close'?'close':'message',Buffer.from(JSON.stringify({type:'auth_required'})),false));}
 send(raw){const m=JSON.parse(raw);
  if(m.type==='auth'){assert.equal(m.access_token,'synthetic');queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({type:mode==='auth_invalid'?'auth_invalid':'auth_ok'})),false));}
  else {assert.deepEqual(m,{id:1,type:'manifest/get',integration:'kia_uvo'});if(mode==='timeout')return;
   const result={id:1,type:'result',success:true,result:{domain:'kia_uvo',version:mode==='invalid'?'bad':'3.19.0'}};
   queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify(result)),mode==='binary'));}
 }
 terminate(){this.emit('close');}
};}
test('loader read requests only fixed manifest through Node 20 compatible websocket',async()=>{
 assert.equal(await readRuntimeManifest('synthetic',{WebSocketClass:socketClass('ok')}),'3.19.0');
});
for(const mode of ['close','auth_invalid','invalid','binary','timeout'])test('loader fails closed without leaking auth: '+mode,async()=>{
 await assert.rejects(readRuntimeManifest('synthetic',{WebSocketClass:socketClass(mode),timeoutMs:10}),/^Error: reconciliation_manifest_unavailable$/);
});
