import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {NotificationState}=require('./runtime-source/ha-notices/notification_state.cjs');
const base=Date.parse('2026-10-27T10:00:00Z'),iso=ms=>new Date(ms).toISOString();
const notice=at=>({notification_id:'synthetic_notice',title:'PRIVATE_SENTINEL',message:'PRIVATE_SENTINEL',created_at:iso(at)});
function changed(){
 const state=new NotificationState();state.apply({type:'current',notifications:{}},base);
 state.apply({type:'added',notifications:{synthetic_notice:notice(base+80)}},base+105,base+100);
 state.apply({type:'updated',notifications:{synthetic_notice:notice(base+180)}},base+205,base+200);
 state.apply({type:'removed',notifications:{synthetic_notice:notice(base+180)}},base+305,base+300);
 return state;
}
test('each source revision retains its own timestamps; removal is not backdated',()=>{
 const snapshot=changed().snapshot(base+1000);
 assert.equal(snapshot.source_timing_schema_version,1);assert.equal(snapshot.sequence,3);assert.equal(snapshot.events.length,3);
 assert.deepEqual(snapshot.events.map(e=>e.source_timing.source_occurred_at),[iso(base+80),iso(base+180),null]);
 assert.deepEqual(snapshot.events.map(e=>e.source_timing.collector_received_at),[iso(base+100),iso(base+200),iso(base+300)]);
 assert.deepEqual(snapshot.events.map(e=>e.source_timing.collector_observed_at),snapshot.events.map(e=>e.observed_at));
 assert.ok(!JSON.stringify(snapshot.events).includes('PRIVATE_SENTINEL'));
});
test('a duplicate frame creates neither another event nor another timing receipt',()=>{
 const state=new NotificationState();state.apply({type:'current',notifications:{}},base);
 const input={type:'added',notifications:{synthetic_notice:notice(base+80)}};
 state.apply(input,base+105,base+100);const saved=JSON.stringify(state.events);
 assert.equal(state.apply(input,base+205,base+200),0);assert.equal(JSON.stringify(state.events),saved);
});
test('restart preserves existing events, sequences and recorded frame origin',()=>{
 const state=changed(),snapshot=state.snapshot(base+1000),restored=new NotificationState(snapshot);
 assert.deepEqual(restored.events,snapshot.events);assert.equal(restored.sequence,snapshot.sequence);
 restored.apply({type:'current',notifications:{synthetic_notice:notice(base+1080)}},base+1105,base+1100);
 assert.equal(restored.events.at(-1).source_timing.frame_kind,'current');
 const legacy=structuredClone(snapshot);for(const event of legacy.events)delete event.source_timing;
 assert.deepEqual(new NotificationState(legacy).events,legacy.events);
});
test('actual producer metadata reaches SQLite once while signed payload and delivery dedupe stay unchanged',()=>{
 const snapshot=changed().snapshot(base+1000);
 const code=String.raw`
import base64,json,os,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from registry import Registry
from worker import Engine
data=json.load(sys.stdin);now=[data['now']-10];sent=[]
with tempfile.TemporaryDirectory()as tmp:
 os.chmod(tmp,0o700)
 reg=Registry(tmp,'test_owner',approved=True,sender=lambda url,headers,body:(sent.append(json.loads(body))or(200,b'')),clock=lambda:now[0])
 reg.db.execute('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)',('sub','test_owner',json.dumps({'project':'/mnt/data/docker','topics':['ha_notification']}),'https://callback.example.org/events','whsec_'+base64.b64encode(b'x'*32).decode(),None,0,now[0]+86400,now[0],now[0]-1000,1))
 path=Path(tmp)/'snapshot.json';engine=Engine(reg,os.getuid(),os.getuid(),snapshot=path,clock=lambda:now[0]);now[0]=data['now']
 def write(value):path.write_text(json.dumps(value));path.chmod(0o640)
 write(data['snapshot']);assert engine.ingest()
 before=[tuple(r)for r in reg.db.execute('SELECT * FROM event_source_timing ORDER BY event')]
 legacy=data['snapshot']
 for e in legacy['events']:e.pop('source_timing',None)
 write(legacy);now[0]+=1;assert engine.ingest()
 assert before==[tuple(r)for r in reg.db.execute('SELECT * FROM event_source_timing ORDER BY event')]
 engine.tick();engine.tick()
 assert len(sent)==1 and 'source_timing'not in json.dumps(sent)
 stats=reg.status()['ha_notification_source_timing']
 assert stats['measured_source_records']==2 and stats['unknown_source_records']==1
 assert stats['unknown_reasons']=={'removal_source_time_unavailable':1}
 assert reg.status()['attempts_last_24h']==1 and not stats['full24h_proven']
 print(json.dumps({'events':reg.db.execute('SELECT count(*) FROM events').fetchone()[0],'timing_receipts':stats['timing_receipts'],'deliveries':len(sent),'full_goal_accepted':False}))
 reg.db.close()
`;
 const result=spawnSync('python3',['-I','-S','-B','-c',code,fileURLToPath(new URL('./runtime-source/native-events/',import.meta.url))],{encoding:'utf8',input:JSON.stringify({snapshot,now:(base+1000)/1000}),timeout:10000,maxBuffer:32768});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{events:3,timing_receipts:3,deliveries:1,full_goal_accepted:false});
});
