import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export const snapshotScope='mqtt_metadata_backup_snapshot_v1';
const MAX_BYTES=64*1048576,MAX_FILES=41136,MAX_LINE=131072;
const fail=()=>{throw Object.assign(new Error('Protected MQTT backup snapshot is unconfirmed'),{code:'MQTT_METADATA_SNAPSHOT_UNCONFIRMED'});};
const need=value=>{if(!value)fail();};
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===names.slice().sort().join();
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const canonical=value=>JSON.stringify(stable(value));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function limit(name) {
  need(typeof name==='string');
  const data={'data/state.sqlite3':1048576,'data/consumer-state.json':131072,'data/consumer-ack.json':4096,'data/manifest.json':8192};
  if(Object.hasOwn(data,name))return data[name];
  if(/^history\/maintenance(?:-archive)?\.json$/.test(name))return 1048576;
  if(/^history\/(?:maintenance-archive-|backup-plan-|backup-rescue-|binding-|source-policy-seal-)[a-f0-9]{32}\.json$/.test(name))return 65536;
  if(name==='history/restored-history.json')return 1048576;
  if(/^history\/restored-operation-[a-f0-9]{32}\.json$/.test(name))return 69632;
  if(/^history\/restored-receipt-(?:backup-plan|backup-rescue|binding|source-policy-seal)-[a-f0-9]{32}\.json$/.test(name))return 65536;
  fail();
}
const role=name=>name.startsWith('data/')?'observer_data':'historical_maintenance_data_not_authority';
function checkedManifest(m,operationId) {
  const frozen=m?.consistency==='closed_metadata_unknown_cut';
  need(keys(m,['schema_version','scope','operation_id','captured_at_utc','consistency','full24h_proven','current_authority_included','files',...(frozen?['metadata_integrity']:[])])&&
    m.schema_version===1&&m.scope===snapshotScope&&typeof m.operation_id==='string'&&/^[a-f0-9]{32}$/.test(m.operation_id)&&
    (operationId===undefined||m.operation_id===operationId)&&['coordinated_metadata_cut','closed_metadata_unknown_cut'].includes(m.consistency)&&
    (!frozen||m.metadata_integrity==='unknown')&&
    m.full24h_proven===false&&m.current_authority_included===false&&typeof m.captured_at_utc==='string'&&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(m.captured_at_utc)&&Number.isFinite(Date.parse(m.captured_at_utc))&&
    Array.isArray(m.files)&&m.files.length>=4&&m.files.length<=MAX_FILES);
  const names=new Set();let bytes=0;
  for(const row of m.files){
    need(keys(row,['path','bytes','sha256','role'])&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&
      row.bytes<=limit(row.path)&&!names.has(row.path)&&hex(row.sha256)&&row.role===role(row.path));
    names.add(row.path);bytes+=row.bytes;need(bytes<=MAX_BYTES);
  }
  for(const name of ['data/state.sqlite3','data/consumer-state.json','data/manifest.json','history/maintenance.json'])need(names.has(name));
  return {names,bytes};
}

export function verifyBackupSnapshot(directory,{operationId}={}) {
  need(path.isAbsolute(directory)&&fs.realpathSync(directory)===directory);
  function metadata(file,isDirectory) {
    const info=fs.lstatSync(file);
    need((isDirectory?info.isDirectory():info.isFile()&&info.nlink===1)&&
      (info.mode&0o777)===(isDirectory?0o700:0o600)&&info.uid===process.getuid());
    return info;
  }
  metadata(directory,true);const file=path.join(directory,'backup-snapshot.json');
  need(metadata(file,false).size<=16*1048576);
  const raw=fs.readFileSync(file),manifest=JSON.parse(raw.toString('utf8'));need(canonical(manifest)===raw.toString('utf8'));
  const {names,bytes}=checkedManifest(manifest,operationId),actual=new Set();
  for(const folder of fs.readdirSync(directory)) {
    if(folder==='backup-snapshot.json')continue;
    need(['data','history'].includes(folder));metadata(path.join(directory,folder),true);
    for(const name of fs.readdirSync(path.join(directory,folder)))actual.add(folder+'/'+name);
  }
  need(actual.size===names.size&&[...actual].every(name=>names.has(name)));
  for(const row of manifest.files){const source=path.join(directory,row.path);need(metadata(source,false).size===row.bytes&&sha(fs.readFileSync(source))===row.sha256);}
  return {manifest,files:names.size,bytes,directory};
}

/** Files remain private and incomplete until EOF, complete manifest and exit0. */
export async function receiveBackupSnapshot(readable,destination,{operationId}={}) {
  need(typeof operationId==='string'&&/^[a-f0-9]{32}$/.test(operationId));
  need(path.isAbsolute(destination)&&fs.realpathSync(path.dirname(destination))===path.dirname(destination));
  const parent=fs.lstatSync(path.dirname(destination));
  need(parent.isDirectory()&&parent.uid===process.getuid()&&(parent.mode&0o777)===0o700);
  fs.mkdirSync(destination,{mode:0o700});fs.chmodSync(destination,0o700);
  let pending=Buffer.alloc(0),begun=false,complete=null,current=null,total=0;
  const rows=[],seen=new Set();
  function frame(message) {
    need(message&&typeof message==='object'&&!Array.isArray(message)&&complete===null);
    if(!begun) {
      need(keys(message,['frame','schema_version','scope','operation_id','current_authority_included','full24h_proven'])&&
        message.frame==='begin'&&message.schema_version===1&&message.scope===snapshotScope&&
        message.operation_id===operationId&&message.current_authority_included===false&&message.full24h_proven===false);
      begun=true;return;
    }
    if(message.frame==='file') {
      need(!current&&keys(message,['frame','path','bytes','sha256','role'])&&rows.length<MAX_FILES);
      const maximum=limit(message.path);
      need(!seen.has(message.path)&&Number.isSafeInteger(message.bytes)&&message.bytes>=0&&message.bytes<=maximum&&
        total+message.bytes<=MAX_BYTES&&hex(message.sha256)&&message.role===role(message.path));
      const target=path.join(destination,message.path),parent=path.dirname(target);
      fs.mkdirSync(parent,{mode:0o700,recursive:true});
      need(fs.realpathSync(parent)===parent&&(fs.lstatSync(parent).mode&0o777)===0o700);
      const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      fs.fchmodSync(fd,0o600);
      current={fd,row:{path:message.path,bytes:message.bytes,sha256:message.sha256,role:message.role},received:0,hash:crypto.createHash('sha256')};
      seen.add(message.path);return;
    }
    if(message.frame==='chunk') {
      need(current&&keys(message,['frame','offset','data'])&&message.offset===current.received&&typeof message.data==='string'&&
        message.data.length>0&&message.data.length<=43692&&/^[A-Za-z0-9+/]+={0,2}$/.test(message.data));
      const data=Buffer.from(message.data,'base64');
      need(data.length>0&&data.length<=32768&&data.toString('base64')===message.data&&current.received+data.length<=current.row.bytes);
      let offset=0;while(offset<data.length){const written=fs.writeSync(current.fd,data,offset);need(written>0);offset+=written;}
      current.hash.update(data);current.received+=data.length;return;
    }
    if(message.frame==='file_end') {
      need(current&&keys(message,['frame'])&&current.received===current.row.bytes&&current.hash.digest('hex')===current.row.sha256);
      fs.fsyncSync(current.fd);fs.closeSync(current.fd);rows.push(current.row);total+=current.received;current=null;return;
    }
    need(message.frame==='complete'&&!current&&keys(message,['frame','metadata','files','bytes','manifest_sha256'])&&
      message.files===rows.length&&message.bytes===total);
    need(keys(message.metadata,['schema_version','scope','operation_id','captured_at_utc','consistency','full24h_proven','current_authority_included',
      ...(message.metadata?.consistency==='closed_metadata_unknown_cut'?['metadata_integrity']:[])]));
    const m={...message.metadata,files:rows};
    checkedManifest(m,operationId);need(sha(canonical(m))===message.manifest_sha256);
    complete=m;
  }
  try {
    for await(const chunk of readable) {
      pending=Buffer.concat([pending,Buffer.from(chunk)]);
      let split;
      while((split=pending.indexOf(10))!==-1) {
        need(split>0&&split<=MAX_LINE);const line=pending.subarray(0,split);pending=pending.subarray(split+1);
        frame(JSON.parse(line.toString('utf8')));
      }
      need(pending.length<=MAX_LINE);
    }
    need(pending.length===0&&complete!==null&&!current);
    return {manifest:complete,files:rows.length,bytes:total,destination};
  } catch {fail();}
  finally {if(current)fs.closeSync(current.fd);}
}

export async function exportBackupSnapshot(destination,{operationId,helperFile,maximumCommandMs,mode='live',invoke=spawn}={}) {
  need(typeof helperFile==='string'&&helperFile==='/opt/raspberry-mqtt-observation/backup_cli.py'&&
    Number.isSafeInteger(maximumCommandMs)&&maximumCommandMs>0&&maximumCommandMs<=30000);
  need(['live','closed'].includes(mode));
  const child=invoke('/usr/bin/sudo',['-n','/usr/bin/python3','-I','-S','-B',helperFile,mode==='closed'?'export-closed':'export',operationId],
    {stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
  const terminal=new Promise(resolve=>{child.once('error',()=>resolve(null));child.once('close',(code,signal)=>resolve({code,signal}));});
  const timer=setTimeout(()=>child.kill('SIGTERM'),maximumCommandMs);
  try {
    need(child.stdout);const result=await receiveBackupSnapshot(child.stdout,destination,{operationId});
    const exit=await terminal;need(exit?.code===0&&exit.signal===null);
    need(result.manifest.consistency===(mode==='closed'?'closed_metadata_unknown_cut':'coordinated_metadata_cut'));
    const file=path.join(destination,'backup-snapshot.json');
    fs.writeFileSync(file,canonical(result.manifest),{mode:0o600,flag:'wx'});
    const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return result;
  } catch {child.kill('SIGTERM');await terminal;fail();}
  finally {clearTimeout(timer);}
}
