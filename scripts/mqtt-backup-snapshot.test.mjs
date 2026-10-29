import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {receiveBackupSnapshot,exportBackupSnapshot,verifyBackupSnapshot,snapshotScope} from './mqtt-backup-snapshot.mjs';
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const canonical=v=>JSON.stringify(sorted(v)),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const operationId='a'.repeat(32);
function fixture(t,extra=0,restored=false) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mqtt-snapshot-transport-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const payloads=new Map(['data/state.sqlite3','data/consumer-state.json','data/manifest.json','history/maintenance.json'].map(n=>[n,Buffer.from('SYNTHETIC_'+n)]));
 for(let i=0;i<extra;i++)payloads.set('history/maintenance-archive-'+i.toString(16).padStart(32,'0')+'.json',Buffer.from('{}'));
 if(restored)for(const name of ['restored-history.json','restored-operation-'+operationId+'.json',
   ...['backup-plan','backup-rescue','binding','source-policy-seal'].map(kind=>'restored-receipt-'+kind+'-'+operationId+'.json')])
  payloads.set('history/'+name,Buffer.from('SYNTHETIC_HISTORICAL_DATA'));
 const metadata={schema_version:1,scope:snapshotScope,operation_id:operationId,captured_at_utc:'2026-10-28T10:00:00+00:00',
   consistency:'coordinated_metadata_cut',full24h_proven:false,current_authority_included:false};
 const rows=[...payloads].map(([name,data])=>({path:name,bytes:data.length,sha256:sha(data),role:name.startsWith('data/')?'observer_data':'historical_maintenance_data_not_authority'}));
 const frames=[{frame:'begin',schema_version:1,scope:snapshotScope,operation_id:operationId,current_authority_included:false,full24h_proven:false}];
 for(const row of rows)frames.push({frame:'file',...row},{frame:'chunk',offset:0,data:payloads.get(row.path).toString('base64')},{frame:'file_end'});
 frames.push({frame:'complete',metadata,files:rows.length,bytes:rows.reduce((s,r)=>s+r.bytes,0),manifest_sha256:sha(canonical({...metadata,files:rows}))});
 return {root,destination:path.join(root,'snapshot'),payloads,rows,frames,
   encoded:()=>frames.map(f=>JSON.stringify(f)+'\n').join('')};
}
test('fragmented byte stream reconstructs exact private data and bounded history without a giant trailer',async t=>{
 const f=fixture(t,700),raw=Buffer.from(f.encoded()),pieces=[];
 for(let offset=0;offset<raw.length;offset+=13)pieces.push(raw.subarray(offset,offset+13));
 const result=await receiveBackupSnapshot(Readable.from(pieces),f.destination,{operationId});
 assert.equal(result.files,704);assert(JSON.stringify(f.frames.at(-1)).length<1024);
 for(const [name,bytes]of f.payloads){assert.deepEqual(fs.readFileSync(path.join(f.destination,name)),bytes);assert.equal(fs.statSync(path.join(f.destination,name)).mode&0o777,0o600);}
 assert.equal(fs.existsSync(path.join(f.destination,'backup-snapshot.json')),false,'receiver alone does not attest child exit');
});
test('truncation, path escape, authority, replayed bytes, corrupt hash and fake completion fail closed',async t=>{
 const cases=[
  f=>f.frames.pop(),f=>f.frames[0].operation_id='b'.repeat(32),f=>f.frames[0].current_authority_included=true,
  f=>f.frames[1].path='../authority',f=>f.frames[1].path='data/authorization.json',
  f=>f.frames[1].bytes=64*1048576+1,f=>f.frames[2].offset=1,f=>f.frames[2].data='!!!!',
  f=>f.frames[1].sha256='f'.repeat(64),f=>f.frames.at(-1).manifest_sha256='f'.repeat(64),
  f=>f.frames.splice(4,0,structuredClone(f.frames[1])),f=>f.frames.push({frame:'complete'}),
  f=>f.frames.at(-1).files++,f=>f.frames.at(-1).metadata.full24h_proven=true,
 ];
 for(const mutate of cases){const f=fixture(t);mutate(f);await assert.rejects(receiveBackupSnapshot(Readable.from([f.encoded()]),f.destination,{operationId}),{code:'MQTT_METADATA_SNAPSHOT_UNCONFIRMED'});assert.equal(fs.existsSync(path.join(f.destination,'backup-snapshot.json')),false);}
});
test('extra partial line and pre-existing destination cannot publish a snapshot',async t=>{
 const f=fixture(t);await assert.rejects(receiveBackupSnapshot(Readable.from([f.encoded()+'partial']),f.destination,{operationId}));
 const g=fixture(t);fs.mkdirSync(g.destination);fs.writeFileSync(path.join(g.destination,'owner-state'),'keep');
 await assert.rejects(receiveBackupSnapshot(Readable.from([g.encoded()]),g.destination,{operationId}));
 assert.equal(fs.readFileSync(path.join(g.destination,'owner-state'),'utf8'),'keep');
});
test('only a successful fixed helper exit publishes the checked outer manifest',async t=>{
 for(const exitCode of [0,1]){
  const f=fixture(t),calls=[];
  const invoke=(command,args,options)=>{
   calls.push({command,args,options});const child=new EventEmitter();child.stdout=Readable.from([f.encoded()]);child.kill=()=>true;
   setImmediate(()=>child.emit('close',exitCode,null));return child;
  };
  const run=exportBackupSnapshot(f.destination,{operationId,helperFile:'/opt/raspberry-mqtt-observation/backup_cli.py',maximumCommandMs:1000,invoke});
  if(exitCode===0){await run;const manifest=fs.readFileSync(path.join(f.destination,'backup-snapshot.json'),'utf8');assert.equal(sha(manifest),f.frames.at(-1).manifest_sha256);}
  else{await assert.rejects(run);assert.equal(fs.existsSync(path.join(f.destination,'backup-snapshot.json')),false);}
  assert.deepEqual(calls[0].args.slice(-2),['export',operationId]);
  assert.deepEqual(calls[0].options.env,{PATH:'/usr/bin:/bin',LC_ALL:'C'});
 }
});
test('on-disk verification rejects coercible operation IDs and timestamps without UTC proof',async t=>{
 const f=fixture(t),invoke=()=>{const child=new EventEmitter();child.stdout=Readable.from([f.encoded()]);child.kill=()=>true;setImmediate(()=>child.emit('close',0,null));return child;};
 await exportBackupSnapshot(f.destination,{operationId,helperFile:'/opt/raspberry-mqtt-observation/backup_cli.py',maximumCommandMs:1000,invoke});
 const file=path.join(f.destination,'backup-snapshot.json'),original=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(verifyBackupSnapshot(f.destination).files,4);
 for(const delta of [{operation_id:[operationId]},{captured_at_utc:'2026'},{captured_at_utc:'2026-10-28T10:00:00+01:00'}]){
  fs.writeFileSync(file,canonical({...original,...delta}));assert.throws(()=>verifyBackupSnapshot(f.destination));
 }
});
test('restored history survives streaming and verification without admitting live authority paths',async t=>{
 const f=fixture(t,0,true),invoke=()=>{const child=new EventEmitter();child.stdout=Readable.from([f.encoded()]);child.kill=()=>true;setImmediate(()=>child.emit('close',0,null));return child;};
 await exportBackupSnapshot(f.destination,{operationId,helperFile:'/opt/raspberry-mqtt-observation/backup_cli.py',maximumCommandMs:1000,invoke});
 assert.equal(verifyBackupSnapshot(f.destination).files,10);
 for(const [name,raw]of f.payloads)assert.deepEqual(fs.readFileSync(path.join(f.destination,name)),raw);
 for(const name of ['history/authorization.json','history/restored-source-policy.json','history/restored-operation-bad.json']){
  const g=fixture(t,0,true);g.frames[1].path=name;
  await assert.rejects(receiveBackupSnapshot(Readable.from([g.encoded()]),g.destination,{operationId}));
 }
});
