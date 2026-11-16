// Fixed HA subscription, no inbound server, service calls, dismissals or writes to HA.
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {NotificationState}=require('./notification_state.cjs');
const STATE='/var/lib/raspberry-ha-notices';
function atomic(directory,name,value,mode){
 const info=fs.lstatSync(directory);if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o022))throw Error('unsafe_state');
 const target=path.join(directory,name),temp=path.join(directory,'.'+name+'.new');
 if(fs.existsSync(target)){const s=fs.lstatSync(target);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw Error('unsafe_state');}
 const raw=JSON.stringify(value)+'\n';if(Buffer.byteLength(raw)>524288)throw Error('snapshot_limit');
 const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);
 try{fs.fchmodSync(fd,mode);fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temp,target);const parent=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
function load(directory){
 const target=path.join(directory,'cache.json');let fd;
 try{fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)||s.size>524288)throw Error('invalid_cache');return JSON.parse(fs.readFileSync(fd,'utf8'));}
 catch(e){if(e.code==='ENOENT')return null;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
// Private operational spool. A fixed local producer leaves closed JSON notices
// here; they enter the same sanitized state, private capture and event path as
// HA persistent notifications but never exist in Home Assistant, so they reach
// neither its frontend nor a phone. The reserved identifier prefix belongs to
// the spool alone: an HA notification using it is ignored.
const SPOOL='/var/lib/raspberry-eva-notices/spool',SPOOL_PRODUCER_UID=1001,SPOOL_PREFIX='eva_private_';
const SPOOL_NAME=/^eva_private_[a-z0-9_]{1,64}\.json$/,SPOOL_MAX=16,SPOOL_BYTES=16384;
const SPOOL_ALIASES=Object.freeze({"eva_private_native_systemd_procmon":"nodered_observabilidade_global_host_failure_native_systemd_procmon","eva_private_native_systemd_mcp_collection":"nodered_observabilidade_global_host_failure_native_systemd_mcp_collection","eva_private_native_systemd_external_heartbeat":"nodered_observabilidade_global_host_failure_native_systemd_external_heartbeat","eva_private_native_docker_ai_bridge":"nodered_observabilidade_global_host_failure_native_docker_ai-bridge","eva_private_observation_host_report":"nodered_observabilidade_global_host_failure_observation_host_report"});
function readSpool(directory=SPOOL,producerUid=SPOOL_PRODUCER_UID){
 const found=new Map();let info;
 try{info=fs.lstatSync(directory);}catch(e){if(e.code==='ENOENT')return found;throw e;}
 if(!info.isDirectory()||info.uid!==producerUid||(info.mode&0o002))throw Error('unsafe_spool');
 const names=fs.readdirSync(directory).filter(name=>SPOOL_NAME.test(name)).sort();
 if(names.length>SPOOL_MAX)throw Error('spool_limit');
 for(const name of names){
  let fd;
  try{fd=fs.openSync(path.join(directory,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}
  catch(e){if(e.code==='ENOENT')continue;throw e;}
  try{
   const s=fs.fstatSync(fd);
   if(!s.isFile()||s.nlink!==1||s.uid!==producerUid||(s.mode&0o002)||s.size<=0||s.size>SPOOL_BYTES)throw Error('unsafe_spool_entry');
   const v=JSON.parse(fs.readFileSync(fd,'utf8')),id=name.slice(0,-5);
   const alias=SPOOL_ALIASES[id];
   const tombstone=Boolean(alias)&&v?.operation==='dismiss';
   const keys=tombstone?['created_at','message','notification_id','operation','schema_version','title']:['created_at','message','notification_id','schema_version','title'];
   if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(Object.keys(v).sort())!==JSON.stringify(keys)||
      v.schema_version!==1||v.notification_id!==id||typeof v.title!=='string'||!v.title.length||v.title.length>200||
      typeof v.message!=='string'||(!tombstone&&!v.message.length)||v.message.length>6000||typeof v.created_at!=='string'||!Number.isFinite(Date.parse(v.created_at)))throw Error('invalid_spool_entry');
   const canonical=alias??id;
   if(found.has(canonical))throw Error('spool_identity_collision');
   found.set(canonical,tombstone?null:{notification_id:canonical,title:v.title,message:v.message,created_at:new Date(Date.parse(v.created_at)).toISOString()});
  }finally{fs.closeSync(fd);}
 }
 return found;
}
// Pure difference between the spool content already delivered and the current
// one, expressed as the frames the HA subscription itself would have sent.
function spoolFrames(applied,current){
 const changed={},removed={};
 for(const[id,value]of current){if(value===null){if(applied.get(id)!==null)removed[id]={notification_id:id};}else if(JSON.stringify(applied.get(id))!==JSON.stringify(value))changed[id]=value;}
 for(const id of applied.keys())if(!current.has(id))removed[id]={notification_id:id};
 const frames=[];
 if(Object.keys(changed).length)frames.push({type:'updated',notifications:changed});
 if(Object.keys(removed).length)frames.push({type:'removed',notifications:removed});
 return frames;
}
function connect({WebSocket,token,expectedUserHash,allowAdministrativeIdentity=false,state,publish,clock=Date.now,onTerminal=()=>{},onReconnect=()=>{},serviceProbe=null,privateCapture=null,spool=null}){
 if(typeof expectedUserHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedUserHash))throw Error('identity_binding_required');
 privateCapture?.reconnect();
 let ended=false,authenticated=false,roleRequested=false,identityVerified=false,subscribed=false,lastPing=0;
 // Spool content last delivered on this connection; a failed read keeps it, so
 // an unreadable spool never looks like every private notice being withdrawn.
 let spoolApplied=new Map(),spoolObserved=false;
 const readSpoolOrKeep=()=>{if(!spool)return new Map();try{const current=spool.read();spoolObserved=true;spool.status?.(null,[...current.values()].filter(v=>v!==null).length);return current;}catch{spool.status?.('private_spool_unreadable',[...spoolApplied.values()].filter(v=>v!==null).length);if(!spoolObserved)throw Error('private_spool_unreadable');return spoolApplied;}};
 const deliver=(event,received,privateIds=new Set())=>{const observed=clock();state.apply(event,observed,received,rawId=>privateIds.has(rawId)?'private_operational_spool':'homeassistant.persistent_notification');try{privateCapture?.observe(event,[...state.current.values()],new Date(observed).toISOString());}catch{privateCapture?.collectionFailure();}};
 const syncSpool=()=>{if(!spool)return;const current=readSpoolOrKeep();if(current===spoolApplied)return;
  for(const frame of spoolFrames(spoolApplied,current))deliver(frame,clock(),new Set([...spoolApplied.keys(),...current.keys()]));spoolApplied=current;};
 const ws=new WebSocket('ws://127.0.0.1:8123/api/websocket',{maxPayload:262144,handshakeTimeout:5000,perMessageDeflate:false});
 const finish=(reason,terminal=false)=>{if(ended)return;ended=true;clearTimeout(deadline);clearInterval(heartbeat);try{serviceProbe?.stop();}catch{}privateCapture?.failure();state.failure(reason);try{publish()}catch{}ws.terminate();terminal?onTerminal():onReconnect();};
 const deadline=setTimeout(()=>finish('subscription_refused'),10000);
 const heartbeat=setInterval(()=>{
  if(ended)return;
  if(process.memoryUsage().rss>160*1048576){finish('resource_budget_exceeded',true);return;}
  if(subscribed&&lastPing&&clock()-state.lastPong>10000){finish('pong_timeout');return;}
  if(subscribed){lastPing=clock();ws.ping();try{syncSpool();}catch{finish('invalid_response',true);return;}try{publish()}catch{finish('storage_failed',true)}}
 },5000);
 ws.on('pong',()=>state.pong(clock()));
 ws.on('error',()=>finish('connection_failed'));ws.on('close',()=>finish('connection_closed'));
 ws.on('message',raw=>{if(ended)return;const received=clock();try{
  const msg=JSON.parse(raw);
  if(msg.type==='auth_required'&&!authenticated){authenticated=true;ws.send(JSON.stringify({type:'auth',access_token:token}));}
  else if(msg.type==='auth_ok'&&authenticated&&!roleRequested){roleRequested=true;ws.send(JSON.stringify({id:1,type:'auth/current_user'}));}
  else if(msg.type==='result'&&msg.id===1){
   const user=msg.result;
   if(!roleRequested||msg.success!==true||user?.is_owner!==false||user?.is_admin!==allowAdministrativeIdentity||typeof user?.id!=='string'||createHash('sha256').update(user.id).digest('hex')!==expectedUserHash)finish('credential_role_refused',true);
   else{identityVerified=true;ws.send(JSON.stringify({id:2,type:'persistent_notification/subscribe'}));}
  }
  else if(msg.type==='auth_invalid')finish('auth_failed',true);
  else if(msg.type==='result'&&msg.id===2&&!msg.success)finish('subscription_refused',true);
  else if(msg.type==='event'&&msg.id===2){if(!identityVerified||!subscribed&&msg.event?.type!=='current')throw Error('invalid_response');
   let event=msg.event;
   if(spool&&event?.notifications&&typeof event.notifications==='object'&&!Array.isArray(event.notifications)){
    // The reserved prefix is spool-only; a full HA frame is completed with the
    // spool so it cannot withdraw notices that HA never knew about.
    // Reconcile fixed local ownership before accepting any HA frame. Claimed
    // aliases, including durable tombstones, always keep their canonical ID.
    if(event.type==='current')spoolApplied=readSpoolOrKeep();else syncSpool();
    const own=Object.fromEntries(Object.entries(event.notifications).filter(([id])=>!id.startsWith(SPOOL_PREFIX)&&!spoolApplied.has(id)));
    if(event.type==='current'){event={...event,notifications:{...own,...Object.fromEntries([...spoolApplied].filter(([,v])=>v!==null))}};}
    else event={...event,notifications:own};
   }
   deliver(event,received,new Set(event.type==='current'?[...spoolApplied.keys()]:[]));const first=!subscribed;subscribed=true;clearTimeout(deadline);if(first){try{serviceProbe?.start();}catch{/* Native notices remain independent. */}}publish();}
 }catch{finish('invalid_response',true)}});
 return {stop:()=>{ended=true;clearTimeout(deadline);clearInterval(heartbeat);privateCapture?.failure();try{serviceProbe?.stop();}catch{}ws.terminate();}};
}
function main(){
 if(process.getuid()===0||process.argv.length!==2)throw Error('fixed_nonroot_entrypoint_required');
 const credentialDirectory=process.env.CREDENTIALS_DIRECTORY;
 if(!credentialDirectory||!credentialDirectory.startsWith('/run/credentials/'))throw Error('credential_directory_required');
 const fd=fs.openSync(path.join(credentialDirectory,'ha-token'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let token;try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size<16||s.size>8192)throw Error('invalid_credential');token=fs.readFileSync(fd,'utf8').trim();}finally{fs.closeSync(fd);}
 const identityFd=fs.openSync('/etc/raspberry-ha-notices/identity.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let identity;
 try{const s=fs.fstatSync(identityFd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o022)||s.size>1024)throw Error('identity_binding_required');identity=JSON.parse(fs.readFileSync(identityFd,'utf8'));}finally{fs.closeSync(identityFd);}
 if(!['system-read-only','approved_existing_administrator'].includes(identity.role))throw Error('approved_identity_required');
 const WebSocket=require('./vendor/ws');const state=new NotificationState(load(STATE));
 let privateCapture=null;
 try{const {createPrivateCapture}=require('./private_capture.cjs');privateCapture=createPrivateCapture();}catch{/* No grant or failure keeps legacy notices independent. */}
 const publish=()=>{const snapshot=state.snapshot(Date.now());
  snapshot.private_content=privateCapture?privateCapture.status():{state:'not_activated_or_unavailable',collection_error:'private_content_access_not_activated'};
  atomic(STATE,'cache.json',snapshot,0o600);atomic(STATE+'/public','snapshot.json',snapshot,0o640);
  if(privateCapture)try{atomic(STATE+'/public','private-events.json',privateCapture.events(),0o640);}catch{privateCapture.collectionFailure();}
 };
 let serviceProbe=null;try{
 const scopeFd=fs.openSync('/usr/local/lib/raspberry-ha-notices/icloud-readiness.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let scope;
 try{const s=fs.fstatSync(scopeFd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o022)||s.size>2048)throw Error('readiness_scope_required');scope=JSON.parse(fs.readFileSync(scopeFd,'utf8'));}finally{fs.closeSync(scopeFd);}
 if(scope.schema_version!==1||scope.minimum_poll_seconds!==60||typeof scope.expires_at!=='number'||scope.enabled!==true)throw Error('readiness_scope_required');
 const {ServiceProbe}=require('./service_probe.cjs');
 serviceProbe=new ServiceProbe(token,snapshot=>atomic(STATE+'/public','icloud-service.json',snapshot,0o640),{expiry:scope.expires_at,revoked:()=>fs.existsSync('/run/raspberry-icloud-read/revoked')});
 }catch{/* Optional readiness failure never stops the original notification observer. */}
 publish();let attempt=0,connection,retry;
 let spoolState={state:'unknown',collection_error:'not_yet_observed',current_entries:0};
 const spool={read:()=>readSpool(),status:(error,count)=>{const next={state:error?'unknown':'observed',collection_error:error,current_entries:count};
  if(JSON.stringify(next)===JSON.stringify(spoolState))return;spoolState=next;
  try{atomic(STATE+'/public','private-spool.json',{schema_version:1,source:'fixed_private_operational_spool_v1',observed_at:new Date().toISOString(),...next,
   coverage:['local_producer_notices_only','never_created_in_home_assistant','not_phone_delivery','delivery_requires_active_HA_subscription']},0o640);}catch{/* Status is advisory; notices stay independent. */}}};
 const start=()=>{connection=connect({WebSocket,token,expectedUserHash:identity.user_id_sha256,allowAdministrativeIdentity:identity.role==='approved_existing_administrator',state,publish,serviceProbe,privateCapture,spool,onTerminal:()=>{process.exitCode=78;},onReconnect:()=>{retry=setTimeout(start,Math.min(60000,5000*2**Math.min(attempt++,4)));}})};
 start();process.once('SIGTERM',()=>{clearTimeout(retry);connection?.stop();state.failure('connection_closed');try{publish()}catch{}process.exitCode=0;});
}
module.exports={atomic,load,connect,readSpool,spoolFrames,SPOOL_PREFIX,SPOOL_ALIASES};
if(require.main===module){try{main()}catch{process.stderr.write('{"collection_error":"startup_failed","credentials_exposed":false}\n');process.exitCode=78;}}
