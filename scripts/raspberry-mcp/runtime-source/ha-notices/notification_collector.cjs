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
function connect({WebSocket,token,expectedUserHash,allowAdministrativeIdentity=false,state,publish,clock=Date.now,onTerminal=()=>{},onReconnect=()=>{}}){
 if(typeof expectedUserHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedUserHash))throw Error('identity_binding_required');
 let ended=false,authenticated=false,roleRequested=false,identityVerified=false,subscribed=false,lastPing=0;
 const ws=new WebSocket('ws://127.0.0.1:8123/api/websocket',{maxPayload:262144,handshakeTimeout:5000,perMessageDeflate:false});
 const finish=(reason,terminal=false)=>{if(ended)return;ended=true;clearTimeout(deadline);clearInterval(heartbeat);state.failure(reason);try{publish()}catch{}ws.terminate();terminal?onTerminal():onReconnect();};
 const deadline=setTimeout(()=>finish('subscription_refused'),10000);
 const heartbeat=setInterval(()=>{
  if(ended)return;
  if(process.memoryUsage().rss>96*1048576){finish('resource_budget_exceeded',true);return;}
  if(subscribed&&lastPing&&clock()-state.lastPong>10000){finish('pong_timeout');return;}
  if(subscribed){lastPing=clock();ws.ping();try{publish()}catch{finish('storage_failed',true)}}
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
  else if(msg.type==='event'&&msg.id===2){if(!identityVerified||!subscribed&&msg.event?.type!=='current')throw Error('invalid_response');state.apply(msg.event,clock(),received);subscribed=true;clearTimeout(deadline);publish();}
 }catch{finish('invalid_response',true)}});
 return {stop:()=>{ended=true;clearTimeout(deadline);clearInterval(heartbeat);ws.terminate();}};
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
 const publish=()=>{const snapshot=state.snapshot(Date.now());atomic(STATE,'cache.json',snapshot,0o600);atomic(STATE+'/public','snapshot.json',snapshot,0o640);};
 publish();let attempt=0,connection,retry;
 const start=()=>{connection=connect({WebSocket,token,expectedUserHash:identity.user_id_sha256,allowAdministrativeIdentity:identity.role==='approved_existing_administrator',state,publish,onTerminal:()=>{process.exitCode=78;},onReconnect:()=>{retry=setTimeout(start,Math.min(60000,5000*2**Math.min(attempt++,4)));}})};
 start();process.once('SIGTERM',()=>{clearTimeout(retry);connection?.stop();state.failure('connection_closed');try{publish()}catch{}process.exitCode=0;});
}
module.exports={atomic,load,connect};
if(require.main===module){try{main()}catch{process.stderr.write('{"collection_error":"startup_failed","credentials_exposed":false}\n');process.exitCode=78;}}
