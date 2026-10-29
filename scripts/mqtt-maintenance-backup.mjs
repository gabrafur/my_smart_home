import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {exportBackupSnapshot,snapshotScope} from './mqtt-backup-snapshot.mjs';

const contractFile='/run/raspberry-mqtt-observation/backup-contract.json';
const installationFile='/etc/raspberry-mqtt-observation/compose.yml';
const helperFile='/opt/raspberry-mqtt-observation/backup_cli.py';
const scope='mqtt_metadata_backup_plan_v1';
const fail=()=>{throw Object.assign(new Error('MQTT metadata backup coordination is unavailable'),
  {code:'MQTT_METADATA_BACKUP_UNCONFIRMED'});};

function present(file) {
  try {fs.lstatSync(file);return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;}
}
function rootFile(file,mode,limit) {
  for(let parent=path.dirname(file);;parent=path.dirname(parent)) {
    const s=fs.lstatSync(parent);
    if(!s.isDirectory()||s.uid!==0||s.gid!==0||(s.mode&0o022)!==0)fail();
    if(parent==='/')break;
  }
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const a=fs.fstatSync(fd);
    if(!a.isFile()||a.nlink!==1||a.uid!==0||a.gid!==0||(a.mode&0o7777)!==mode||a.size>limit)fail();
    const raw=fs.readFileSync(fd),b=fs.fstatSync(fd),named=fs.lstatSync(file);
    if(raw.length!==a.size||a.ino!==b.ino||a.dev!==b.dev||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs||a.size!==b.size||a.ino!==named.ino||a.dev!==named.dev)fail();
    return raw;
  } finally {fs.closeSync(fd);}
}

export function validateBackupContract(v) {
  const keys=['schema_version','scope','enabled','helper_sha256','maximum_command_ms',
    ...(v?.schema_version>=2?['snapshot_scope','snapshot_maximum_command_ms','snapshot_component_manifest_sha256']:[]),
    ...(v?.schema_version===3?['closed_backup_scope']:[])];
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==keys.sort().join()||
    ![1,2,3].includes(v.schema_version)||v.scope!==scope||v.enabled!==true||!/^[a-f0-9]{64}$/.test(v.helper_sha256)||
    !Number.isSafeInteger(v.maximum_command_ms)||v.maximum_command_ms<1||v.maximum_command_ms>2147483647)fail();
  if(v.schema_version>=2&&(v.snapshot_scope!==snapshotScope||!Number.isSafeInteger(v.snapshot_maximum_command_ms)||
    v.snapshot_maximum_command_ms<1||v.snapshot_maximum_command_ms>30000||!/^[a-f0-9]{64}$/.test(v.snapshot_component_manifest_sha256)))fail();
  if(v.schema_version===3&&v.closed_backup_scope!=='mqtt_metadata_closed_backup_v1')fail();
  return v;
}

export function loadBackupMaintenance({readRoot=rootFile,exists=present,invoke=spawnSync,
  operationId=()=>crypto.randomBytes(16).toString('hex'),exportSnapshot=exportBackupSnapshot}={}) {
  if(!exists(contractFile)) {
    if(exists(installationFile))fail();
    return null;
  }
  const raw=readRoot(contractFile,0o444,4096),v=validateBackupContract(JSON.parse(raw));
  const id=operationId();if(!/^[a-f0-9]{32}$/.test(id))fail();
  let mode='live';
  function unchanged() {
    if(!raw.equals(readRoot(contractFile,0o444,4096))||
      crypto.createHash('sha256').update(readRoot(helperFile,0o644,65536)).digest('hex')!==v.helper_sha256)fail();
  }
  function call(action) {
    unchanged();
    const fixedAction=mode==='closed'&&['prepare','resume'].includes(action)?action+'-closed':action;
    const r=invoke('/usr/bin/sudo',['-n','/usr/bin/python3','-I','-S','-B',helperFile,fixedAction,id],{
      encoding:'utf8',timeout:v.maximum_command_ms,maxBuffer:4096,
      env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['ignore','pipe','pipe']});
    if(r.error||r.status!==0)fail();
    const result=JSON.parse(r.stdout);
    const accepted=action==='mode'?['backup_mode_selected']:mode==='closed'?
      [action==='prepare'?'backup_closed_capture_ready':'backup_closed_metadata_complete']:
      action==='rescue'?['backup_rescue_not_required','backup_rescue_house_running_metadata_disabled']:
      [action==='prepare'?'backup_plan_capture_ready':'backup_plan_complete'];
    if(result.operation_id!==id||result.automatic_retry!==false||result.full24h_proven!==false||
      !accepted.includes(result.state)||action==='rescue'&&(result.metadata_integrity!=='unknown'||
        result.metadata_disabled!==(result.state==='backup_rescue_house_running_metadata_disabled')))fail();
    if(action==='mode'&&!['live','closed'].includes(result.mode)||mode==='closed'&&action!=='mode'&&
      (result.metadata_integrity!=='unknown'||result.source_effects_executed!==false))fail();
    return result;
  }
  if(v.schema_version===3)mode=call('mode').mode;
  return {operation_id:id,mode,...(v.schema_version>=2?{
    snapshot_component_manifest_sha256:v.snapshot_component_manifest_sha256,
    async snapshot(destination){unchanged();const result=await exportSnapshot(destination,{operationId:id,helperFile,maximumCommandMs:v.snapshot_maximum_command_ms,mode});unchanged();return result;},
  }:{}),prepare:()=>call('prepare'),resume:()=>{
    if(mode==='closed')return call('resume');
    try {return call('resume');}catch {return call('rescue');}
  }};
}

export async function captureWithOrderedStops({services,maintenance=null,stop,start,capture,wait}) {
  const coordinated=maintenance&&maintenance.mode!=='closed'?['mosquitto','nodered']:[];
  if(maintenance&&coordinated.some(s=>!services.includes(s)))fail();
  const ordinary=services.filter(s=>!coordinated.includes(s));
  let prepareRequested=false,ordinaryStopRequested=false,value,captureError=null,restorationError=null,coordinationError=null;
  try {
    if(maintenance) {prepareRequested=true;maintenance.prepare();}
    if(ordinary.length) {ordinaryStopRequested=true;stop(ordinary);}
    value=await capture();
  } catch(error) {captureError=error;}
  finally {
    // Restore both independent participants even if the other start fails.
    // The fixed helper validates the journal before either coordinated start.
    if(ordinaryStopRequested)try {start(ordinary);}catch(error) {restorationError=error;}
    if(prepareRequested)try {
      if(maintenance.resume()?.metadata_disabled===true)
        coordinationError=Object.assign(new Error('Services restored with metadata observation disabled'),
          {code:'MQTT_METADATA_BACKUP_RESCUED'});
    }catch(error) {restorationError??=error;}
    if(!restorationError&&(ordinaryStopRequested||prepareRequested))
      try {await wait(services);}catch(error) {restorationError=error;}
  }
  return {capture:value,captureError,restorationError:restorationError??coordinationError};
}
