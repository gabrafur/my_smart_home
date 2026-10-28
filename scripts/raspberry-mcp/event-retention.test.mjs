import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {NotificationState}=require('./runtime-source/ha-notices/notification_state.cjs');

test('cache eviction preserves durable events, identities and restart counters without claiming delivery',()=>{
 const state=new NotificationState(),base=Date.parse('2026-10-27T10:00:00Z');
 state.apply({type:'current',notifications:{}},base);
 const snapshots=[];
 for(let i=1;i<=280;i++){
  const at=base+i*10;
  state.apply({type:i===1?'added':'updated',notifications:{synthetic:{notification_id:'synthetic',title:'PRIVATE_SENTINEL',message:'PRIVATE_SENTINEL',created_at:new Date(at).toISOString()}}},at);
  if(i===250||i===280)snapshots.push(structuredClone(state.snapshot(at)));
 }
 const restored=new NotificationState(snapshots[1]);
 assert.equal(restored.dropped,24);assert.equal(restored.sequence,280);
 assert.deepEqual(restored.events,snapshots[1].events);
 assert.deepEqual(snapshots[1].event_retention,{schema_version:1,kind:'rolling_source_cache',capacity:256,evicted_records:24,retained_records:256,first_sequence:25,last_sequence:280,counter_semantics:'cache_evictions_not_confirmed_delivery_loss'});
 const code=String.raw`
import json,os,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from registry import Registry
from worker import Engine
snapshots=json.load(sys.stdin);clock=[1793095199.0]
with tempfile.TemporaryDirectory() as tmp:
 os.chmod(tmp,0o700);r=Registry(tmp,'test_owner',approved=True,clock=lambda:clock[0])
 p=Path(tmp)/'snapshot.json';engine=Engine(r,os.getuid(),os.getuid(),snapshot=p,clock=lambda:clock[0])
 for index,row in enumerate(snapshots):
  if index:
   # Seed the existing archive tier; archive/prune policy is tested separately.
   ids=[r[0] for r in r.db.execute('SELECT id FROM events ORDER BY created LIMIT 24')]
   for identity in ids:
    r.db.execute("INSERT INTO event_archive SELECT id,topic,body,created,?,'eligibility_window_elapsed' FROM events WHERE id=?",(clock[0],identity))
    r.db.execute('DELETE FROM events WHERE id=?',(identity,))
  from worker import timestamp
  clock[0]=timestamp(row['observed_at']);p.write_text(json.dumps(row));p.chmod(0o640);assert engine.ingest(),engine.source_health
 status=engine.source_health['event_retention']
 assert status['cache_evictions']==24 and status['retained_records_persisted']==256
 assert status['retained_records_not_persisted']==0 and not status['historical_delivery_proven']
 assert r.db.execute('SELECT count(*) FROM (SELECT id FROM events UNION SELECT id FROM event_archive)').fetchone()[0]==280
 assert r.db.execute('SELECT count(*) FROM dispatch').fetchone()[0]==0
 before=tuple(r.db.execute('SELECT count(*) FROM events').fetchone());assert engine.ingest()
 assert tuple(r.db.execute('SELECT count(*) FROM events').fetchone())==before
 r.db.execute('DELETE FROM event_archive WHERE id=(SELECT id FROM event_archive LIMIT 1)')
 # The removed row was outside the current cache; coverage is deliberately bounded.
 assert engine.retention_status(row)['retained_records_not_persisted']==0
 r.db.execute('DELETE FROM events WHERE id=(SELECT id FROM events ORDER BY created DESC LIMIT 1)')
 assert engine.retention_status(row)['retained_records_not_persisted']==1
 legacy=dict(row);legacy.pop('event_retention');assert engine.retention_status(legacy)['state']=='unknown'
 bad=dict(row);bad['sequence']+=1;assert engine.retention_status(bad)['reason']=='retention_metadata_invalid'
 row['events'][0]['sequence']+=1;assert engine.retention_status(row)['state']=='unknown'
 assert not r.db.execute("SELECT count(*) FROM meta WHERE key LIKE '%retention%'").fetchone()[0]
 r.db.close()
 print('passed')
`;
 const result=spawnSync('python3',['-I','-S','-B','-c',code,fileURLToPath(new URL('./runtime-source/native-events/',import.meta.url))],{input:JSON.stringify(snapshots),encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'passed');
});
