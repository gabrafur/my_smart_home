import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonical,digest} from './consumer_protocol.mjs';
import {ConsumerStore,StoreInvalid} from './consumer_store.mjs';
import {schema,zeroCounts} from './consumer_protocol.mjs';
import {CheckpointInvalid,bindCheckpoint,decodeCommit,encodeCheckpointCommit,validateCheckpoint,
  violations,MAX_WINDOW_HISTORY} from './canvas_checkpoint.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./synthetic-protocol-fixture.json',import.meta.url),'utf8'));
function checkpoint(plan,previous=null){
  const receipt=plan.receipt_facts[0]?.bucket_id??previous?.receipt_id??'0';
  const window=previous?structuredClone(previous.window):{
    id_sha256:'a'.repeat(64),phase:'tracking',reason:'collecting',clock_domain_sha256:'d'.repeat(64),
    started_at_ns:'100',observed_at_ns:'100',first_receipt_id:'0',last_receipt_id:'0',
    baseline_counts:zeroCounts(),acknowledged_counts:zeroCounts(),
    max_upper_ns_by_kind:Object.fromEntries(schema.kinds.map(k=>[k,null])),
    violations:Object.fromEntries(violations.map(k=>[k,'0'])),
    policy:{event_latency_ms:'10000',window_duration_ns:'86400000000000'},cut:null,
  };
  window.observed_at_ns=(BigInt(window.observed_at_ns)+1n).toString();
  window.last_receipt_id=receipt;window.acknowledged_counts=structuredClone(plan.acknowledged_counts);
  return {schema_version:1,sequence:previous?(BigInt(previous.sequence)+1n).toString():'1',
    previous_sha256:previous?digest(previous):null,proposal_sha:plan.proposal_sha,receipt_id:receipt,
    acknowledged_counts_sha256:digest(plan.acknowledged_counts),window,history:structuredClone(previous?.history??[])};
}
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
test('canvas checkpoint and accounting share the fsynced state before ACK',()=>{
  const env=setup();try{
    const store=env.open(),plan=store.prepare(),c=checkpoint(plan),events=[];
    const rename=fs.renameSync,sync=fs.fsyncSync;
    fs.renameSync=(a,b)=>{
      if(path.basename(b)==='ack.json')assert.deepEqual(store.snapshot().canvas_checkpoint,c);
      events.push('rename:'+path.basename(b));return rename(a,b);
    };
    fs.fsyncSync=fd=>{events.push(fd===store.ownFd?'sync:directory':'sync:file');return sync(fd);};
    let result;
    try{result=store.commit(plan.proposal_sha,c);}finally{fs.renameSync=rename;fs.fsyncSync=sync;}
    const stateAt=events.indexOf('rename:state.json'),ackAt=events.indexOf('rename:ack.json');
    assert.ok(ackAt>stateAt&&events.slice(stateAt+1,ackAt).includes('sync:directory'));
    assert.equal(result.full24h_proven,false);assert.equal(store.snapshot().version,2);
    assert.equal(result.canvas_checkpoint_sha256,digest(c));
  }finally{env.cleanup();}
});
test('reopening restores exact canvas history instead of constructing a new window',()=>{
  const env=setup();try{
    let store=env.open(),p=store.prepare(),c=checkpoint(p);store.commit(p.proposal_sha,c);store.close();
    store=env.open();assert.deepEqual(store.prepare().canvas_checkpoint,c);
    assert.equal(store.prepare().canvas_checkpoint_sha256,digest(c));
    env.report(fixture.done);p=store.prepare();const next=checkpoint(p,c);store.commit(p.proposal_sha,next);
    assert.equal(store.snapshot().canvas_checkpoint.window.last_receipt_id,'1');
    assert.equal(store.snapshot().timing.publish_in.timed,'2');store.close();store=env.open();
    assert.deepEqual(store.prepare().canvas_checkpoint,next);
  }finally{env.cleanup();}
});
test('legacy commit cannot drop an existing checkpoint or expose an ACK',()=>{
  const env=setup();try{
    const store=env.open(),p=store.prepare(),c=checkpoint(p);store.commit(p.proposal_sha,c);
    env.report(fixture.second);const next=store.prepare(),before=fs.readFileSync(path.join(env.own,'state.json'));
    const ack=fs.readFileSync(path.join(env.own,'ack.json'));
    assert.throws(()=>store.commit(next.proposal_sha),error=>error.code==='canvas_checkpoint_required');
    assert.deepEqual(fs.readFileSync(path.join(env.own,'state.json')),before);
    assert.deepEqual(fs.readFileSync(path.join(env.own,'ack.json')),ack);
  }finally{env.cleanup();}
});
test('failed state rename preserves old checkpoint and ACK; exact plan can reconcile',()=>{
  const env=setup();try{
    let store=env.open(),p=store.prepare(),c=checkpoint(p);store.commit(p.proposal_sha,c);
    env.report(fixture.second);p=store.prepare();const next=checkpoint(p,c),before=store.snapshot();
    const rename=fs.renameSync;
    fs.renameSync=(a,b)=>{if(path.basename(b)==='state.json')throw new Error('synthetic disk failure');return rename(a,b);};
    try{assert.throws(()=>store.commit(p.proposal_sha,next),error=>error.code==='consumer_write_failed');}
    finally{fs.renameSync=rename;}
    assert.deepEqual(store.snapshot(),before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.own,'ack.json'))).bucket_id,'1');
    store.close();store=env.open();assert.equal(store.commit(p.proposal_sha,next).state,'committed');
    assert.deepEqual(store.snapshot().canvas_checkpoint,next);
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.own,'ack.json'))).bucket_id,'2');
  }finally{env.cleanup();}
});
test('ACK write failure leaves checkpoint and accounting together for safe recovery',()=>{
  const env=setup();try{
    let store=env.open(),p=store.prepare(),c=checkpoint(p);store.commit(p.proposal_sha,c);
    env.report(fixture.second);p=store.prepare();const next=checkpoint(p,c),rename=fs.renameSync;
    fs.renameSync=(a,b)=>{if(path.basename(b)==='ack.json')throw new Error('synthetic ACK failure');return rename(a,b);};
    try{assert.throws(()=>store.commit(p.proposal_sha,next),error=>error.code==='consumer_write_failed');}
    finally{fs.renameSync=rename;}
    assert.deepEqual(store.snapshot().canvas_checkpoint,next);assert.equal(store.snapshot().last_receipt,'1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.own,'ack.json'))).bucket_id,'1');
    store.close();store=env.open();p=store.prepare();const resumed=checkpoint(p,next);
    assert.equal(store.commit(p.proposal_sha,resumed).state,'committed');
    assert.equal(store.snapshot().timing.publish_in.observed,'2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.own,'ack.json'))).bucket_id,'2');
  }finally{env.cleanup();}
});
test('checkpoint must bind exact proposal, receipt and acknowledged totals',()=>{
  for(const mutate of [c=>c.proposal_sha='b'.repeat(64),c=>c.receipt_id='1',
    c=>c.acknowledged_counts_sha256='b'.repeat(64),c=>c.sequence='2']){
    const env=setup();try{
      const store=env.open(),p=store.prepare(),c=checkpoint(p);mutate(c);
      assert.throws(()=>store.commit(p.proposal_sha,c),CheckpointInvalid);
      assert.equal(store.snapshot(),null);assert.equal(fs.existsSync(path.join(env.own,'ack.json')),false);
    }finally{env.cleanup();}
  }
});
test('same-window counters, violations and timing maxima cannot be erased',()=>{
  const env=setup();try{
    const store=env.open();let p=store.prepare(),c=checkpoint(p);
    c.window.violations.receipt_gaps='2';c.window.max_upper_ns_by_kind.publish_in='900';
    store.commit(p.proposal_sha,c);env.report(fixture.done);p=store.prepare();
    for(const mutate of [x=>x.previous_sha256='f'.repeat(64),x=>x.sequence='1',
      x=>x.window.violations.receipt_gaps='1',x=>x.window.max_upper_ns_by_kind.publish_in=null,
      x=>x.window.max_upper_ns_by_kind.publish_in='899',x=>x.window.started_at_ns='99',
      x=>x.window.policy.event_latency_ms='1']){
      const next=checkpoint(p,c);mutate(next);assert.throws(()=>store.commit(p.proposal_sha,next),CheckpointInvalid);
    }
    assert.deepEqual(store.snapshot().canvas_checkpoint,c);
  }finally{env.cleanup();}
});
test('new window must archive the exact preceding record and preserve older history',()=>{
  const env=setup();try{
    const store=env.open();let p=store.prepare(),c=checkpoint(p);c.window.violations.integrity_faults='3';
    store.commit(p.proposal_sha,c);env.report(fixture.done);p=store.prepare();
    const next=checkpoint(p,c);next.window.id_sha256='b'.repeat(64);
    assert.throws(()=>store.commit(p.proposal_sha,next),CheckpointInvalid);
    next.history=[structuredClone(c.window)];next.history[0].violations.integrity_faults='0';
    assert.throws(()=>store.commit(p.proposal_sha,next),CheckpointInvalid);
    next.history=[structuredClone(c.window)];assert.equal(store.commit(p.proposal_sha,next).state,'committed');
    assert.deepEqual(store.snapshot().canvas_checkpoint.history,[c.window]);
  }finally{env.cleanup();}
});
test('cut boundary cannot move after being recorded',()=>{
  const env=setup();try{
    const store=env.open();let p=store.prepare(),c=checkpoint(p);
    c.window.cut={accepted_frames:'1',source_emitted_at_ns:'100'};store.commit(p.proposal_sha,c);
    p=store.prepare();const next=checkpoint(p,c);next.window.cut=null;
    assert.throws(()=>store.commit(p.proposal_sha,next),CheckpointInvalid);
  }finally{env.cleanup();}
});
test('checkpoint on disk with a recomputed outer digest still needs exact source binding',()=>{
  const env=setup();try{
    const store=env.open(),p=store.prepare(),c=checkpoint(p);store.commit(p.proposal_sha,c);
    const file=path.join(env.own,'state.json'),v=JSON.parse(fs.readFileSync(file));
    v.body.canvas_checkpoint.acknowledged_counts_sha256='f'.repeat(64);v.sha256=digest(v.body);
    fs.writeFileSync(file,canonical(v));assert.throws(()=>store.prepare(),error=>error.code==='consumer_state_invalid');
  }finally{env.cleanup();}
});
test('encoded checkpoint uses a bounded shell-safe alphabet and canonical round trip',()=>{
  const env=setup();try{
    const store=env.open(),p=store.prepare(),c=checkpoint(p),token=encodeCheckpointCommit(p.proposal_sha,c);
    assert.match(token,/^c1_[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCommit(token),{proposal_sha:p.proposal_sha,checkpoint:c});
    assert.deepEqual(decodeCommit(p.proposal_sha),{proposal_sha:p.proposal_sha,checkpoint:null});
    for(const bad of [token+'=',token+'\n','c1_$(false)','c1_'+Buffer.from('{"proposal_sha":"x","proposal_sha":"y"}').toString('base64url'),
      'c1_'+Buffer.alloc(70000,65).toString('base64url')])assert.throws(()=>decodeCommit(bad),CheckpointInvalid);
  }finally{env.cleanup();}
});
test('checkpoint has no private free-text or extra fields and bounded history',()=>{
  const env=setup();try{
    const c=checkpoint(env.open().prepare());
    for(const mutate of [x=>x.payload='PRIVATE_CANARY',x=>x.window.reason='PRIVATE_CANARY',
      x=>x.window.policy.extra='PRIVATE_CANARY',x=>x.window.violations.extra='1',
      x=>x.history=Array(MAX_WINDOW_HISTORY+1).fill(x.window),x=>x.window.started_at_ns='-1',
      x=>x.window.max_upper_ns_by_kind.publish_in='18446744073709551616']){
      const bad=structuredClone(c);mutate(bad);assert.throws(()=>validateCheckpoint(bad),CheckpointInvalid);
    }
  }finally{env.cleanup();}
});
test('storing a canvas assertion cannot make the metadata adapter prove global24h',()=>{
  const env=setup();try{
    const store=env.open(),p=store.prepare(),c=checkpoint(p);c.window.phase='passed';c.window.reason='complete';
    assert.equal(store.commit(p.proposal_sha,c).full24h_proven,false);
    assert.equal(store.prepare().full24h_proven,false);
  }finally{env.cleanup();}
});
test('checkpoint-only route records uncertainty after producer directory disappears without ACK effects',()=>{
  const env=setup();try{
    let store=env.open(),p=store.prepare(),c=checkpoint(p);store.commit(p.proposal_sha,c);store.close();
    const ack=fs.readFileSync(path.join(env.own,'ack.json')),before=JSON.parse(fs.readFileSync(path.join(env.own,'state.json'))).body;
    fs.rmSync(env.reports,{recursive:true});
    store=new ConsumerStore(env.own,env.reports,{...env.options,ownOnly:true});
    try{
      p=store.prepareCheckpoint();const next=checkpoint({...p,receipt_facts:[]},c);
      next.window.phase='unknown';next.window.reason='reader_unknown';next.window.violations.reader_unknown_observations='1';
      const result=store.commitCheckpoint(p.proposal_sha,next);
      assert.equal(result.state,'checkpoint_committed');assert.equal(result.ack_written,false);assert.equal(result.ack_intended,false);
      const after=store.snapshot();delete before.canvas_checkpoint;delete after.canvas_checkpoint;
      assert.deepEqual(after,before);assert.deepEqual(fs.readFileSync(path.join(env.own,'ack.json')),ack);
      assert.throws(()=>store.prepare(),error=>error.code==='consumer_report_required');
      assert.throws(()=>store.commit(p.proposal_sha,next),error=>error.code==='consumer_report_required');
    }finally{store.close();}
  }finally{env.cleanup();}
});
test('checkpoint-only proposal CAS cannot overwrite a newer durable record',()=>{
  const env=setup();try{
    const store=env.open();let p=store.prepare(),c=checkpoint(p);store.commit(p.proposal_sha,c);
    p=store.prepareCheckpoint();const next=checkpoint({...p,receipt_facts:[]},c);
    store.commitCheckpoint(p.proposal_sha,next);const before=store.snapshot();
    assert.equal(store.commitCheckpoint(p.proposal_sha,next).state,'stale_prepare');assert.deepEqual(store.snapshot(),before);
    assert.throws(()=>store.commitCheckpoint(p.proposal_sha,null),error=>error.code==='consumer_proposal_invalid');
  }finally{env.cleanup();}
});
test('checkpoint-only preparation cannot invent missing consumer history',()=>{
  const env=setup();try{
    const store=env.open();assert.throws(()=>store.prepareCheckpoint(),error=>error.code==='consumer_history_missing');
    assert.deepEqual(fs.readdirSync(env.own),['lock']);
  }finally{env.cleanup();}
});
test('producer and checkpoint-only proposal domains cannot authorize each other',()=>{
  const env=setup();try{
    const store=env.open(),producer=store.prepare();store.commit(producer.proposal_sha);
    const own=store.prepareCheckpoint(),c=checkpoint({...own,receipt_facts:[]});
    const before=store.snapshot(),ack=fs.readFileSync(path.join(env.own,'ack.json'));
    assert.notEqual(own.proposal_sha,producer.proposal_sha);
    assert.equal(store.commit(own.proposal_sha,c).state,'stale_prepare');
    assert.equal(store.commitCheckpoint(producer.proposal_sha,c).state,'stale_prepare');
    assert.deepEqual(store.snapshot(),before);assert.deepEqual(fs.readFileSync(path.join(env.own,'ack.json')),ack);
  }finally{env.cleanup();}
});
test('coverage cut remains distinct from a legacy emission-only timestamp',()=>{
  const env=setup();try{
    const store=env.open(),p=store.prepare(),c=checkpoint(p);
    c.window.cut={accepted_frames:'1',covered_before_ns:'100'};validateCheckpoint(c);
    const legacy=structuredClone(c);legacy.window.cut={accepted_frames:'1',source_emitted_at_ns:'100'};
    validateCheckpoint(legacy);assert.equal('covered_before_ns'in legacy.window.cut,false);
    const ambiguous=structuredClone(c);ambiguous.window.cut.source_emitted_at_ns='100';
    assert.throws(()=>validateCheckpoint(ambiguous),CheckpointInvalid);
    store.commit(p.proposal_sha,c);const nextPlan=store.prepare(),next=checkpoint(nextPlan,c);
    next.window.cut=legacy.window.cut;
    assert.throws(()=>store.commit(nextPlan.proposal_sha,next),CheckpointInvalid);
  }finally{env.cleanup();}
});
