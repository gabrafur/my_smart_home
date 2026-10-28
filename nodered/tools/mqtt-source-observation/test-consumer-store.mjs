import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonical,digest} from './consumer_protocol.mjs';
import {ConsumerStore,StoreInvalid} from './consumer_store.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./synthetic-protocol-fixture.json',import.meta.url),'utf8'));
function setup({lock=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mqtt-consumer-store-'));
  const own=path.join(root,'consumer'),reports=path.join(root,'reports');
  fs.mkdirSync(own,{mode:0o700});fs.chmodSync(own,0o700);fs.mkdirSync(reports,{mode:0o750});fs.chmodSync(reports,0o750);
  const locked=fs.openSync(path.join(own,'lock'),'wx+',0o600);fs.fchmodSync(locked,0o600);
  if(lock){
    const io=Array(locked+1).fill('ignore');io[locked]=locked;
    const result=spawnSync('/usr/bin/flock',['-n',String(locked)],{stdio:io});assert.equal(result.status,0);
  }
  const options={consumerUid:process.getuid(),consumerGid:process.getgid(),publisherUid:process.getuid(),lockFd:locked};
  const report=value=>{fs.writeFileSync(path.join(reports,'report.json'),canonical(value),{mode:0o640});fs.chmodSync(path.join(reports,'report.json'),0o640);};
  report(fixture.first);
  let store;
  function open(){store=new ConsumerStore(own,reports,options);return store;}
  function cleanup(){store?.close();fs.closeSync(locked);fs.rmSync(root,{recursive:true,force:true});}
  return {root,own,reports,options,locked,open,report,cleanup};
}
test('prepare persists a ticket without state or ACK effects',()=>{
  const env=setup();try{
    const store=env.open(),prepared=store.prepare();
    assert.equal(prepared.state,'prepared');assert.equal(prepared.ack_intended,true);
    assert.equal(prepared.received_counts.stats.publish_in.observed,'2');
    assert.equal(store.snapshot(),null);
    assert.equal(fs.existsSync(path.join(env.own,'state.json')),false);
    assert.equal(fs.existsSync(path.join(env.own,'ack.json')),false);
    assert.equal(fs.statSync(path.join(env.own,'prepared.json')).mode&0o777,0o600);
  }finally{env.cleanup();}
});
test('commit fsyncs accounting and directory before exposing an ACK',()=>{
  const env=setup();try{
    const store=env.open(),prepared=store.prepare(),events=[];
    const rename=fs.renameSync,sync=fs.fsyncSync;
    fs.renameSync=(a,b)=>{events.push('rename:'+path.basename(b));return rename(a,b);};
    fs.fsyncSync=fd=>{events.push(fd===store.ownFd?'sync:directory':'sync:file');return sync(fd);};
    try{assert.equal(store.commit(prepared.proposal_sha).state,'committed');}
    finally{fs.renameSync=rename;fs.fsyncSync=sync;}
    const stateAt=events.indexOf('rename:state.json'),ackAt=events.indexOf('rename:ack.json');
    assert.ok(stateAt>=0&&ackAt>stateAt);
    assert.ok(events.slice(stateAt+1,ackAt).includes('sync:directory'));
    assert.equal(store.snapshot().received_counts.stats.publish_in.observed,'2');
    const ack=JSON.parse(fs.readFileSync(path.join(env.own,'ack.json'),'ascii'));
    assert.equal(ack.bucket_id,'1');
  }finally{env.cleanup();}
});
test('reopening durable pending state does not double-count or reset history',()=>{
  const env=setup();try{
    let store=env.open(),prepared=store.prepare();store.commit(prepared.proposal_sha);store.close();
    store=env.open();const before=store.snapshot(),again=store.prepare();store.commit(again.proposal_sha);
    assert.deepEqual(store.snapshot(),before);
    env.report(fixture.done);const done=store.prepare();assert.equal(done.receipt_facts.length,1);
    store.commit(done.proposal_sha);assert.equal(store.snapshot().timing.publish_in.timed,'2');
    store.close();store=env.open();assert.equal(store.prepare().receipt_facts.length,0);
  }finally{env.cleanup();}
});
test('a new preparation invalidates an older ticket without mutating source state',()=>{
  const env=setup();try{
    const store=env.open(),one=store.prepare();store.commit(one.proposal_sha);
    env.report(fixture.done);const two=store.prepare(),before=store.snapshot();
    assert.equal(store.commit(one.proposal_sha).state,'stale_prepare');assert.deepEqual(store.snapshot(),before);
    assert.equal(store.commit(two.proposal_sha).state,'committed');
  }finally{env.cleanup();}
});
test('prepared base-state CAS prevents committing the same plan twice',()=>{
  const env=setup();try{
    const store=env.open(),plan=store.prepare();store.commit(plan.proposal_sha);
    const before=fs.readFileSync(path.join(env.own,'state.json'),'ascii');
    assert.equal(store.commit(plan.proposal_sha).state,'stale_prepare');
    assert.equal(fs.readFileSync(path.join(env.own,'state.json'),'ascii'),before);
  }finally{env.cleanup();}
});
test('state write failure never writes an ACK or silently recreates state',()=>{
  const env=setup();try{
    const store=env.open(),plan=store.prepare(),sync=fs.fsyncSync;
    fs.fsyncSync=()=>{throw new Error('PRIVATE_FS_CANARY');};
    try{assert.throws(()=>store.commit(plan.proposal_sha),error=>error.code==='consumer_write_failed');}
    finally{fs.fsyncSync=sync;}
    assert.equal(fs.existsSync(path.join(env.own,'state.json')),false);
    assert.equal(fs.existsSync(path.join(env.own,'ack.json')),false);
    assert.deepEqual(fs.readdirSync(env.own).sort(),['lock','prepared.json']);
  }finally{env.cleanup();}
});
test('failure after durable state but before ACK is recoverable on reopen',()=>{
  const env=setup();try{
    let store=env.open(),plan=store.prepare();const rename=fs.renameSync;
    fs.renameSync=(a,b)=>{if(path.basename(b)==='ack.json')throw new Error('PRIVATE_CANARY');return rename(a,b);};
    try{assert.throws(()=>store.commit(plan.proposal_sha),error=>error.code==='consumer_write_failed');}
    finally{fs.renameSync=rename;}
    assert.equal(store.snapshot().pending.body.bucket_id,'1');assert.equal(fs.existsSync(path.join(env.own,'ack.json')),false);
    store.close();store=env.open();const retry=store.prepare();store.commit(retry.proposal_sha);
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.own,'ack.json'),'ascii')).bucket_id,'1');
    assert.equal(store.snapshot().received_counts.stats.publish_in.observed,'2');
  }finally{env.cleanup();}
});
test('post-rename directory sync uncertainty is reconciled before ACK',()=>{
  const env=setup();try{
    const store=env.open(),plan=store.prepare(),sync=fs.fsyncSync;let failed=false;
    fs.fsyncSync=fd=>{if(fd===store.ownFd&&!failed){failed=true;throw new Error('PRIVATE_CANARY');}return sync(fd);};
    try{assert.throws(()=>store.commit(plan.proposal_sha),error=>error.code==='consumer_write_failed');}
    finally{fs.fsyncSync=sync;}
    assert.equal(fs.existsSync(path.join(env.own,'state.json')),true);
    assert.equal(fs.existsSync(path.join(env.own,'ack.json')),false);
    const next=store.prepare();store.commit(next.proposal_sha);
    assert.equal(store.snapshot().received_counts.stats.publish_in.observed,'2');
    assert.equal(fs.existsSync(path.join(env.own,'ack.json')),true);
  }finally{env.cleanup();}
});
test('corrupt state is preserved and no fallback state or new ACK is created',()=>{
  const env=setup();try{
    const store=env.open();fs.writeFileSync(path.join(env.own,'state.json'),'PRIVATE_CANARY',{mode:0o600});
    assert.throws(()=>store.prepare(),error=>error.code==='consumer_state_invalid');
    assert.equal(fs.readFileSync(path.join(env.own,'state.json'),'ascii'),'PRIVATE_CANARY');
    assert.equal(fs.existsSync(path.join(env.own,'ack.json')),false);
  }finally{env.cleanup();}
});
test('consumer-state loss after Root acknowledged history requires reconciliation',()=>{
  const env=setup();try{
    env.report(fixture.done);const store=env.open();
    assert.throws(()=>store.prepare(),error=>error.code==='consumer_history_missing');
    assert.equal(fs.existsSync(path.join(env.own,'state.json')),false);
    assert.equal(fs.existsSync(path.join(env.own,'ack.json')),false);
  }finally{env.cleanup();}
});
test('symlinked state cannot cause a read or overwrite outside the metadata directory',()=>{
  const env=setup();try{
    const target=path.join(env.root,'outside');fs.writeFileSync(target,'PRIVATE_CANARY');fs.symlinkSync(target,path.join(env.own,'state.json'));
    const store=env.open();assert.throws(()=>store.prepare(),StoreInvalid);
    assert.equal(fs.readFileSync(target,'ascii'),'PRIVATE_CANARY');
  }finally{env.cleanup();}
});
test('a regular descriptor without a held kernel flock is rejected',()=>{
  const env=setup({lock:false});try{
    assert.throws(()=>env.open(),error=>error.code==='consumer_lock_required');
    assert.deepEqual(fs.readdirSync(env.own),['lock']);
  }finally{env.cleanup();}
});
test('proposal input cannot inject a command or arbitrary file path',()=>{
  const env=setup();try{
    const store=env.open();assert.throws(()=>store.commit('PRIVATE_CANARY; /tmp/anything'),error=>error.code==='consumer_proposal_invalid');
    assert.deepEqual(fs.readdirSync(env.own),['lock']);
  }finally{env.cleanup();}
});
