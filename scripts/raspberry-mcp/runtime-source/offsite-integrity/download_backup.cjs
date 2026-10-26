// Fixed read-only HA inventory + ONE encrypted download. No password in URLs.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const WebSocket=require('../../../../nodered/node_modules/ws');
const ROOT='/var/lib/raspberry-offsite-integrity-operation-binding/stdin-recovery-r2';
const ID_HASH='ARTIFACT_ID_SHA256_BINDING';
const SIZE=20480;
const progress={stage:'not_started',bytes_received:0,bytes_written:0,expected_bytes:SIZE,http_status:null,started_at_ms:null};
const REASONS=new Set(['inventory_not_ready','fixed_artifact_not_found','fixed_remote_artifact_changed','fixed_backup_metadata_changed','backup_incomplete','inventory_timeout','inventory_connection_failed','inventory_auth_failed','inventory_refused','inventory_invalid','download_byte_limit','download_write_failed','download_incomplete','download_deadline','download_transport_failed','download_inactivity','download_http_refused','download_size_changed','fixed_non_root_command_required','token_metadata_invalid']);
const CODES=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOSPC','EDQUOT','EACCES','EPERM','EIO','EBADF','EFBIG','EMFILE','ENFILE','ERR_STREAM_PREMATURE_CLOSE','ERR_HTTP_CONTENT_LENGTH_MISMATCH','ABORT_ERR']);
function failureReport(error){
 return {error:'fixed_download_failed',automatic_retry:false,diagnostic:{
  stage:progress.stage,reason:REASONS.has(error?.message)?error.message:'unclassified_failure',
  code:CODES.has(error?.code)?error.code:null,bytes_received:progress.bytes_received,
  bytes_written:progress.bytes_written,expected_bytes:SIZE,http_status:progress.http_status,
  elapsed_ms:progress.started_at_ms===null?null:Math.max(0,Date.now()-progress.started_at_ms)}};
}
function requireValue(ok,reason){if(!ok)throw Error(reason);}
function select(info,expectedIdHash=ID_HASH){
 requireValue(info?.state==='idle'&&Array.isArray(info.backups)&&info.backups.length<=1000&&!Object.keys(info.agent_errors||{}).length,'inventory_not_ready');
 const rows=info.backups.filter(b=>typeof b.backup_id==='string'&&crypto.createHash('sha256').update(b.backup_id).digest('hex')===expectedIdHash);
 requireValue(rows.length===1,'fixed_artifact_not_found');const b=rows[0];
 const agents=Object.entries(b.agents||{}).filter(([id])=>id.startsWith('onedrive.'));
 requireValue(agents.length===1&&agents[0][1].protected===true&&agents[0][1].size===SIZE,'fixed_remote_artifact_changed');
 requireValue(b.date==='2000-01-01T00:00:00+00:00'&&b.name==='Daily off-site Compose v1 SYNTHETIC'&&b.homeassistant_included===true&&b.database_included===false,'fixed_backup_metadata_changed');
 requireValue(['failed_agent_ids','failed_folders','failed_addons'].every(k=>Array.isArray(b[k])&&b[k].length===0),'backup_incomplete');
 return {id:b.backup_id,agent:agents[0][0]};
}
function inventory(token){return new Promise((resolve,reject)=>{
 const ws=new WebSocket('ws://127.0.0.1:8123/api/websocket',{maxPayload:1048576,handshakeTimeout:5000});
 let done=false;const timer=setTimeout(()=>finish(Error('inventory_timeout')),15000);
 function finish(error,value){if(done)return;done=true;clearTimeout(timer);ws.terminate();error?reject(error):resolve(value);}
 ws.on('error',()=>finish(Error('inventory_connection_failed')));
 ws.on('message',raw=>{try{const row=JSON.parse(raw);
  if(row.type==='auth_required')ws.send(JSON.stringify({type:'auth',access_token:token}));
  else if(row.type==='auth_ok')ws.send(JSON.stringify({id:1,type:'backup/info'}));
  else if(row.type==='auth_invalid')finish(Error('inventory_auth_failed'));
  else if(row.id===1&&row.type==='result')row.success?finish(null,select(row.result)):finish(Error('inventory_refused'));
 }catch{finish(Error('inventory_invalid'));}});
});}
async function copyEncryptedResponse(response,fd,expectedSize=SIZE){
 progress.stage='streaming';progress.bytes_received=0;progress.bytes_written=0;
 let bytes=0;const digest=crypto.createHash('sha256'),started=Date.now();
 for await(const chunk of response){
  bytes+=chunk.length;progress.bytes_received=bytes;requireValue(bytes<=expectedSize,'download_byte_limit');digest.update(chunk);
  let offset=0;while(offset<chunk.length){const written=fs.writeSync(fd,chunk,offset,chunk.length-offset);requireValue(written>0,'download_write_failed');offset+=written;progress.bytes_written+=written;}
  const wait=Math.ceil(bytes/(4*1024*1024)*1000)-(Date.now()-started);if(wait>0)await delay(wait);
 }
 progress.stage='verify_length';requireValue(bytes===expectedSize,'download_incomplete');progress.stage='fsync';fs.fsyncSync(fd);progress.stage='completed';
 return {encrypted_bytes:bytes,encrypted_sha256:digest.digest('hex'),duration_ms:Date.now()-started};
}
async function download(token,chosen){
 progress.stage='request';progress.started_at_ms=Date.now();
 const url=new URL('http://127.0.0.1:8123/api/backup/download/'+encodeURIComponent(chosen.id));url.searchParams.set('agent_id',chosen.agent);
 const fd=fs.openSync(ROOT+'/backup.tar',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 let request;const timer=setTimeout(()=>request?.destroy(Error('download_deadline')),600000);
 try{
  const response=await new Promise((resolve,reject)=>{
   request=http.get(url,{headers:{Authorization:'Bearer '+token},timeout:30000},resolve);
   request.once('error',error=>reject(error));
   request.once('timeout',()=>request.destroy(Error('download_inactivity')));
  });
  progress.http_status=response.statusCode;progress.stage='headers';requireValue(response.statusCode===200,'download_http_refused');
  if(response.headers['content-length']!==undefined)requireValue(Number(response.headers['content-length'])===SIZE,'download_size_changed');
  return {backup_id_sha256:ID_HASH,...await copyEncryptedResponse(response,fd),downloads:1,credentials_exposed:false};
 }finally{clearTimeout(timer);request?.destroy();fs.closeSync(fd);}
}
async function main(){
 requireValue(process.getuid()===1001&&process.argv.length===2,'fixed_non_root_command_required');
 const fd=fs.openSync('/mnt/data/docker/.local-secrets/ha-long-lived-token.txt',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let token;try{const s=fs.fstatSync(fd);requireValue(s.isFile()&&s.uid===1001&&(s.mode&0o777)===0o600&&s.size<=4096,'token_metadata_invalid');token=fs.readFileSync(fd,'utf8').trim();}finally{fs.closeSync(fd);}
 progress.stage='inventory';const chosen=await inventory(token);return download(token,chosen);
}
module.exports={select,copyEncryptedResponse,ID_HASH,SIZE,failureReport};
if(require.main===module)main().then(x=>console.log(JSON.stringify(x))).catch(error=>{console.log(JSON.stringify(failureReport(error)));process.exitCode=1;});
