#!/usr/bin/env node
// Fixed SMLIGHT update transaction. Timing and candidate authorization belong
// to the daily Node-RED canvas; this adapter revalidates the effect boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {validateNetwork,adapterRestoreScript} from './zigbee-coordinator-recovery.mjs';
const require=createRequire(import.meta.url);
const ROOT='/mnt/data/docker',PRIVATE='/var/lib/zigbee-coordinator-recovery';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function atomic(file,value,mode=0o600){const tmp=file+'.'+process.pid+'.tmp';const fd=fs.openSync(tmp,'wx',mode);try{fs.fchmodSync(fd,mode);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file)}
function read(file,limit=4*1024*1024){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw Error('unsafe_file');return fs.readFileSync(file,'utf8')}
function optional(file,value){try{return JSON.parse(read(file))}catch(e){if(e.code==='ENOENT')return value;throw e}}

export function versionParts(value){
 const s=String(value||'');if(/^\d{8}$/.test(s))return [Number(s),0,0,1,0];
 const m=s.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[.-](dev|beta|rc)(\d*))?$/i);
 return m?[Number(m[1]),Number(m[2]),Number(m[3]),m[4]?0:1,Number(m[5]||0)]:null;
}
export function newerStable(target,installed){
 const a=versionParts(target),b=versionParts(installed);if(!a||!b||a[3]!==1)return false;
 for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]>b[i]}return false;
}
export function validFirmwareRequest(r,now){
 return !!r&&Object.keys(r).sort().join(',')==='entity_id,expected_installed_version,id,requested_at,source,stable_only,target_version,version'&&
  r.version===1&&/^[a-f0-9]{32}$/.test(r.id)&&/^update\.[a-z0-9_]+$/.test(r.entity_id)&&r.source==='daily_updates'&&r.stable_only===true&&
  Number.isFinite(r.requested_at)&&r.requested_at<=now&&now-r.requested_at<=6*3600000&&newerStable(r.target_version,r.expected_installed_version);
}

const smlightScript=String.raw`
import asyncio,json,sys,time,re,urllib.parse
from pysmlight import Api2
q=json.load(sys.stdin)
async def main():
 async with Api2(q['host']) as api:
  info=await api.get_info()
  def radio_index(role):
   indices=[i for i,r in enumerate(info.radios or []) if (r.zb_type==0 if role=='zigbee_update' else r.zb_type in [5,6,7])]
   if len(indices)!=1:raise ValueError('ambiguous_radio')
   return indices[0]
  def installed(role):
   return str(info.sw_version) if role=='core_update' else str(info.radios[radio_index(role)].zb_version)
  async def releases(role):
   if role=='core_update':return await api.get_firmware_version('release',device=info.model) or []
   idx=radio_index(role)
   return await api.get_firmware_version('release',device=info.model,mode='zigbee',zb_type=info.radios[idx].zb_type,idx=idx) or []
  if q['mode']=='inventory':
   out=[]
   for t in q['targets']:
    fw=await releases(t['role']);v=installed(t['role']);latest=str(fw[0].ver) if fw else None
    out.append({'entity_id':t['entity_id'],'installed_version':v,'latest_version':latest,'is_stable':bool(fw and not fw[0].dev),'in_progress':False,'state_class':'pending' if latest and latest!=v else 'current','observed_at':int(time.time()*1000),'search_key':'smlight coordinator firmware'})
   return {'schema_version':1,'observed_at':int(time.time()*1000),'updates':out}
  t=q['target'];v=installed(t['role'])
  if q['mode']=='state':return {'state':'off' if v==q['version'] else 'on','installed':v,'latest':q['version'],'in_progress':None if q.get('dispatched') and v!=q['version'] else False}
  fw=await releases(t['role'])
  if not fw or str(fw[0].ver)!=q['version'] or fw[0].dev:raise ValueError('candidate_not_latest_stable')
  u=urllib.parse.urlparse(fw[0].link)
  if u.scheme!='https' or u.hostname!='updates.smlight.tech' or not u.path.startswith('/firmware/'):raise ValueError('unapproved_vendor_url')
  if q['mode']=='approve':return {'approved':True}
  if q['mode']!='install' or v!=q['expected_installed']:raise ValueError('candidate_changed')
  accepted=await api.fw_update(fw[0],0 if t['role']=='core_update' else radio_index(t['role']))
  # The SDK collapses a lost response into False; that does not prove no dispatch.
  return {'accepted':bool(accepted),'dispatched':True if accepted else None}
try:print(json.dumps(asyncio.run(main())))
except Exception as e:
 print(json.dumps({'ok':False,'reason':str(e) if str(e) in ['ambiguous_radio','candidate_not_latest_stable','unapproved_vendor_url','candidate_changed'] else 'vendor_observation_unavailable'}))
 sys.exit(1)
`;
export const probeScript=String.raw`
const fs=require('fs'),y=require('js-yaml'),mqtt=require('mqtt'),c=y.load(fs.readFileSync('/app/data/configuration.yaml','utf8'));
const rows=fs.readFileSync('/app/data/database.db','utf8').trim().split('\n').map(JSON.parse),base=c.mqtt.base_topic||'zigbee2mqtt';
const names=rows.filter(d=>d.type==='Router'&&d.interviewCompleted===true).map(d=>c.devices?.[d.ieeeAddr]?.friendly_name).filter(Boolean);
if(!names.length){process.exitCode=1}else{
 const m=mqtt.connect(c.mqtt.server,{username:c.mqtt.user,password:c.mqtt.password,reconnectPeriod:0,connectTimeout:4000});
 const timer=setTimeout(()=>{process.exitCode=1;m.end(true)},14000);
 m.on('error',()=>{clearTimeout(timer);process.exitCode=1;m.end(true)});
 m.on('connect',()=>m.subscribe(names.map(n=>base+'/'+n),{qos:1},()=>{for(const n of names)m.publish(base+'/'+n+'/get','{"state":""}',{qos:1,retain:false})}));
 m.on('message',(t,b,p)=>{if(!p.retain){try{const s=JSON.parse(b).state;if(s==='ON'||s==='OFF'){clearTimeout(timer);m.end(true)}}catch{}}});
}
`;
const backupScript=String.raw`
const fs=require('fs'),y=require('js-yaml'),mqtt=require('mqtt'),crypto=require('crypto'),c=y.load(fs.readFileSync('/app/data/configuration.yaml','utf8')),tx=crypto.randomBytes(16).toString('hex'),base=c.mqtt.base_topic||'zigbee2mqtt';
const m=mqtt.connect(c.mqtt.server,{username:c.mqtt.user,password:c.mqtt.password,reconnectPeriod:0,connectTimeout:4000});
const timer=setTimeout(()=>{process.exitCode=1;m.end(true)},45000);m.on('error',()=>{clearTimeout(timer);process.exitCode=1;m.end(true)});
m.on('connect',()=>m.subscribe(base+'/bridge/response/backup',{qos:1},()=>m.publish(base+'/bridge/request/backup',JSON.stringify({transaction:tx}),{qos:1,retain:false})));
m.on('message',(t,b,p)=>{if(p.retain)return;const r=JSON.parse(b);if(r.transaction===tx){clearTimeout(timer);if(r.status!=='ok')process.exitCode=1;m.end(true)}});
`;

export async function firmwareTransaction(request,ops,job){
 const save=()=>ops.save(job);
 if(!job.dispatch_attempted){
  const s=await ops.state(true);
  if(s.installed===request.target_version)return {status:'not_needed',reason:'already_installed'};
  if(versionParts(s.installed)&&!newerStable(request.target_version,s.installed))return {status:'not_needed',reason:'already_at_or_ahead'};
  if(s.state!=='on'||s.latest!==request.target_version||s.installed!==request.expected_installed_version||s.in_progress!==false||!newerStable(s.latest,s.installed))throw Error('candidate_changed');
  await ops.approveStable();
  await ops.preflight?.();
  await ops.probe();
  job.phase='backing_up';save();await ops.backup();
  job.phase='backup_ready';save();
  await ops.stop();job.phase='stopped';save();
  job.dispatch_attempted=true;job.phase='install_sent';save();
  let acknowledgement;try{acknowledgement=await ops.install()}catch{}
  if(acknowledgement?.accepted===false&&acknowledgement.dispatched===false){
   job.dispatch_attempted=false;job.phase='installation_rejected';save();await ops.start();
   return {status:'failed',reason:'vendor_rejected_without_dispatch'};
  } // An uncertain install is observed, never resent.
 }
 let confirmed=false,oldFirmware=false;
 for(let i=0;i<12;i++){
  try{const s=await ops.state(true);if(s.installed===request.target_version&&s.in_progress===false){confirmed=true;break}
   if(i>=1&&s.installed===request.expected_installed_version&&s.in_progress===false&&['on','off'].includes(s.state)){oldFirmware=true;break}}
  catch{}
  await ops.wait(15000);
 }
 if(!confirmed&&!oldFirmware){job.phase='awaiting_install_confirmation';save();return {status:'pending',reason:'install_outcome_unknown'}}
 job.phase='restoring';save();
 try{
  await ops.restore();job.phase='radio_restored';save();
 }finally{await ops.start()}
 for(let i=0;i<6;i++){try{await ops.probe();job.phase='verified';save();return {status:confirmed?'updated':'failed',reason:confirmed?'network_verified':'installation_failed_network_recovered'}}catch{}await ops.wait(20000)}
 return {status:'failed',reason:'network_not_verified'};
}

function docker(args,timeout=60000){const r=spawnSync('/usr/bin/docker',args,{encoding:'utf8',timeout,maxBuffer:4*1024*1024});if(r.error||r.status!==0)throw Error('docker_operation_failed');return r.stdout}
function coordinatorIdentity(config){
 const host=new URL(config.serial.port).hostname;
 const entries=JSON.parse(read(path.join(ROOT,'homeassistant/.storage/core.config_entries'))).data.entries;
 const allowed=new Set(entries.filter(e=>e.domain==='smlight'&&e.data?.host===host).map(e=>e.entry_id));
 const entities=JSON.parse(read(path.join(ROOT,'homeassistant/.storage/core.entity_registry'))).data.entities;
 const targets=entities.filter(e=>e.platform==='smlight'&&allowed.has(e.config_entry_id)&&!e.disabled_by&&['core_update','zigbee_update'].includes(e.translation_key)).map(e=>({entity_id:e.entity_id,role:e.translation_key}));
 if(!targets.length)throw Error('coordinator_entities_missing');return {host,targets};
}
export function decodeVendorResponse(result,mode,status,error=false){
 if(error)throw Error('vendor_observation_unavailable');
 if(status!==0||result?.ok===false){
  if(mode==='install'&&result?.ok===false&&['ambiguous_radio','candidate_not_latest_stable','unapproved_vendor_url','candidate_changed'].includes(result.reason))return {accepted:false,dispatched:false};
  throw Error(/^[a-z_]+$/.test(result?.reason)?result.reason:'vendor_observation_unavailable');
 }
 return result;
}
function vendor(identity,mode,request,dispatched=false){
 const target=request?identity.targets.find(t=>t.entity_id===request.entity_id):null;
 if(request&&!target)throw Error('target_not_coordinator');
 const q={host:identity.host,targets:identity.targets,target,mode,version:request?.target_version,expected_installed:request?.expected_installed_version,dispatched};
 const r=spawnSync('/usr/bin/docker',['exec','-i','homeassistant','python','-c',smlightScript],{input:JSON.stringify(q),encoding:'utf8',timeout:mode==='inventory'?90000:60000,maxBuffer:1024*1024});
 let result;try{result=JSON.parse(r.stdout)}catch{throw Error('vendor_observation_unavailable')}
 return decodeVendorResponse(result,mode,r.status,!!r.error);
}
export async function publishFirmwareInventory(){
 const config=require('js-yaml').load(read(path.join(ROOT,'zigbee2mqtt/configuration.yaml'))),identity=coordinatorIdentity(config);
 const inventory=vendor(identity,'inventory');
 atomic(path.join(ROOT,'nodered/zigbee-recovery/firmware-inventory.json'),inventory,0o644);return inventory;
}

export async function processFirmwareQueue(){
 const publicDir=path.join(ROOT,'nodered/zigbee-recovery'),queue=path.join(publicDir,'firmware-requests');
 const ledgerFile=path.join(PRIVATE,'firmware-jobs.json'),marker=path.join(PRIVATE,'firmware-active.json');
 const ledger=optional(ledgerFile,{jobs:[],events:[]});
 const names=fs.readdirSync(queue).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).sort();
 let request,file,job;
 const active=ledger.jobs.find(j=>j.status==='pending'||j.status==='running');
 if(active){request=active.request;file=path.join(queue,request.id+'.json');job=active}
 else for(const name of names){const p=path.join(queue,name);let r;try{r=JSON.parse(read(p,8192))}catch{continue}
  if(!validFirmwareRequest(r,Date.now())||name!==r.id+'.json')continue;
  const old=ledger.jobs.find(j=>j.request.id===r.id);if(old){fs.unlinkSync(p);continue}
  const duplicate=ledger.jobs.find(j=>j.request.entity_id===r.entity_id&&j.request.target_version===r.target_version&&j.dispatch_attempted);
  if(duplicate){fs.unlinkSync(p);continue}
  request=r;file=p;job={request:r,status:'running',phase:'admitted',dispatch_attempted:false,restore_attempts:0};ledger.jobs.push(job);break;
 }
 if(!request)return;
 const persist=()=>atomic(ledgerFile,ledger);
 persist();atomic(marker,{id:request.id,active:true});
 const dataDir=path.join(ROOT,'zigbee2mqtt');let config;
 let outcome;
 try{
  config=require('js-yaml').load(read(path.join(dataDir,'configuration.yaml')));
  if(!job.dispatch_attempted&&!validFirmwareRequest(request,Date.now()))throw Error('request_expired');
  const identity=coordinatorIdentity(config);
  const ops={save:persist,wait:pause,state:async()=>vendor(identity,'state',request,job.dispatch_attempted),approveStable:async()=>vendor(identity,'approve',request),
   preflight:async()=>{if(docker(['ps','--filter','name=^/zigbee-(coordinator|firmware-network)-restore$','--format','{{.Names}}']).trim())throw Error('radio_restore_still_running');docker(['exec','zigbee2mqtt','node','-e',"if(require('zigbee-herdsman/package.json').version!=='11.2.0'||typeof require('zigbee-herdsman/dist/adapter/adapter').Adapter.create!=='function')process.exit(1)"])},
   probe:async()=>{docker(['exec','zigbee2mqtt','node','-e',probeScript],20000)},
   backup:async()=>{
    docker(['exec','zigbee2mqtt','node','-e',backupScript],55000);
    const raw=read(path.join(dataDir,'database.db')),validated=validateNetwork(config,JSON.parse(read(path.join(dataDir,'coordinator_backup.json'))),raw);
    const last=optional(path.join(PRIVATE,'last-good.json'),null);
    if(last&&(validated.identity!==last.identity||validated.devices<last.devices))throw Error('backup_would_lose_devices');
    const bundle={version:1,saved_at:Date.now(),identity:validated.identity,devices:validated.devices,configuration:read(path.join(dataDir,'configuration.yaml')),database:raw,backup:JSON.stringify(validated.backup,null,2)+'\n'};bundle.digest=hash(JSON.stringify(bundle));
    atomic(path.join(PRIVATE,'pre-firmware-'+request.id+'.json'),bundle);atomic(path.join(PRIVATE,'last-good.json'),bundle);job.backup_digest=bundle.digest;persist();
   },
   stop:async()=>{docker(['stop','-t','20','zigbee2mqtt'],35000)},install:async()=>vendor(identity,'install',request),
   restore:async()=>{
    const bundle=JSON.parse(read(path.join(PRIVATE,'pre-firmware-'+request.id+'.json'))),{digest,...body}=bundle;
    if(digest!==job.backup_digest||hash(JSON.stringify(body))!==digest)throw Error('backup_integrity_failed');
    const currentConfig=require('js-yaml').load(read(path.join(dataDir,'configuration.yaml')));
    const validated=validateNetwork(currentConfig,JSON.parse(bundle.backup),bundle.database);
    if(validated.identity!==bundle.identity)throw Error('backup_integrity_failed');
    if(job.restore_attempts>=2)throw Error('restore_budget_exhausted');
    const counter=validated.backup.network_key.frame_counter+job.restore_attempts*100000;
    if(counter+2500>0xffffffff)throw Error('network_counter_exhausted');
    validated.backup.network_key.frame_counter=counter;job.restore_attempts++;persist();
    fs.writeFileSync(path.join(dataDir,'database.db'),bundle.database);fs.writeFileSync(path.join(dataDir,'coordinator_backup.json'),JSON.stringify(validated.backup,null,2)+'\n');
    const image=docker(['inspect','zigbee2mqtt','--format','{{.Image}}']).trim();if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('invalid_image_identity');
    docker(['run','--rm','--name','zigbee-firmware-network-restore','--network','host','--memory','192m','--memory-swap','192m','--cpus','0.5','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=16m','--volume',dataDir+':/app/data:rw','--entrypoint','node',image,'-e',adapterRestoreScript],180000);
   },start:async()=>{
    if(docker(['ps','--filter','name=^/zigbee-(coordinator|firmware-network)-restore$','--format','{{.Names}}']).trim())throw Error('radio_restore_still_running');
    docker(['start','zigbee2mqtt'],30000);
   },
  };
  outcome=await firmwareTransaction(request,ops,job);
 }catch(e){
  const terminal=['restore_budget_exhausted','backup_integrity_failed','backup_would_lose_devices','invalid_image_identity'].includes(e.message);
  outcome={status:job.dispatch_attempted&&!terminal?'pending':'failed',reason:/^[a-z_]+$/.test(e.message)?e.message:'transaction_failed'};
  // Before any firmware dispatch it is always safe to resume the original service.
  if(!job.dispatch_attempted&&['stopped','backup_ready'].includes(job.phase)){try{docker(['start','zigbee2mqtt'])}catch{}}
 }
 job.status=outcome.status;job.reason=outcome.reason;job.updated_at=Date.now();persist();
 const event={id:request.id,entity_id:request.entity_id,target_version:request.target_version,status:job.status,reason:job.reason,dispatched:job.dispatch_attempted,at:job.updated_at};
 ledger.events=[...ledger.events,event].slice(-32);persist();
 atomic(path.join(publicDir,'firmware-result.json'),{schema_version:1,observed_at:Date.now(),latest:event,events:ledger.events},0o644);
 if(job.status!=='pending'){fs.rmSync(marker,{force:true});fs.unlinkSync(file)}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const task=process.argv[2]==='--inventory'?publishFirmwareInventory:processFirmwareQueue;
 task().catch(()=>{console.error('ZIGBEE_FIRMWARE observation_failed');process.exitCode=1});
}
