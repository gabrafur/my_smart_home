// Private inherited Unix channel. No credential, payload, HTTP or service API.
import fs from 'node:fs';
import net from 'node:net';
const fail=code=>Object.assign(new Error('first backup Root channel is unconfirmed; automatic retry is disabled'),{code:`BOOTSTRAP_${code}`});
const hex=(s,n)=>typeof s==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(s);
function fresh(value){
  if(Date.now()/1000>=value.expires_at)throw fail('WALL_EXPIRED');
  const match=/^([0-9]+)\.([0-9]{2}) /.exec(fs.readFileSync('/proc/uptime','utf8'));
  if(!match)throw fail('BOOTTIME_UNCONFIRMED');
  if((BigInt(match[1])*100n+BigInt(match[2])+1n)*10000000n>=BigInt(value.deadline_ns))throw fail('BOOTTIME_EXPIRED');
}
export function connectBootstrapChannel(fd,{operationId}={}) {
  if(!Number.isSafeInteger(fd)||fd<3||!hex(operationId,32))throw fail('CONFIG');
  const socket=new net.Socket({fd,readable:true,writable:true});let used=false,reported=false,pending=null,buffer='',verifiedReply=null;
  socket.ref();
  socket.setEncoding('utf8');
  const reject=code=>{if(pending){const p=pending;pending=null;p.reject(fail(code));}};
  socket.on('error',()=>reject('IO_ERROR'));socket.on('end',()=>reject('EOF'));socket.on('close',()=>reject('CLOSED'));
  socket.on('data',chunk=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>4096){reject('REPLY_SIZE');socket.destroy();return;}
    if(!buffer.includes('\n'))return;
    const [line,...extra]=buffer.split('\n');buffer='';
    if(!pending||extra.length!==1||extra[0]!==''){reject('REPLY_FRAME');socket.destroy();return;}
    const p=pending;pending=null;
    try{p.resolve(JSON.parse(line));}catch{p.reject(fail('REPLY_JSON'));socket.destroy();}
  });
  function request(value){
    if(pending||socket.destroyed||socket.readableEnded)return Promise.reject(fail('NOT_WRITABLE'));
    socket.ref();
    return new Promise((resolve,reject)=>{pending={resolve,reject};socket.write(JSON.stringify(value)+'\n',error=>{if(error){const p=pending;pending=null;p?.reject(fail('WRITE_ERROR'));}});});
  }
  async function admitRemote({bundleSha256,requestSha256}){
      if(used||!hex(bundleSha256,64)||!hex(requestSha256,64))throw fail('ADMISSION_CONSUMED_OR_INVALID');
      used=true; // Consume locally before writing, including a lost response.
      const value=await request({action:'admit_remote',bundle_sha256:bundleSha256,request_sha256:requestSha256});
      if(!value||typeof value!=='object'||Array.isArray(value)||value.action!=='admit_remote'||value.operation_id!==operationId||value.phase!=='bootstrap_remote_intent'||
        value.newly_recorded!==true||value.worker_witness_recorded!==true||value.dispatch_executed!==false||value.automatic_retry!==false||
        value.independent_acceptance!==false||value.remote_effect_proven!==false||
        !Number.isFinite(value.expires_at)||
        typeof value.deadline_ns!=='string'||!/^[0-9]{1,20}$/.test(value.deadline_ns))throw fail('ADMISSION_REPLY');
      // /proc uptime includes suspend, as does the Root CLOCK_BOOTTIME deadline.
      // Round up by one centisecond, refusing the uncertain final interval.
      fresh(value);verifiedReply=value;
      return {operationId:value.operation_id,automaticRetry:false};
  }
  return Object.freeze({
    admitRemote,
    async dispatchRemote({bundleSha256,requestSha256,beforeSend=()=>{},send}){
      if(typeof send!=='function'||typeof beforeSend!=='function')throw fail('SEND_INVALID');
      const result=await admitRemote({bundleSha256,requestSha256});
      // Finish synchronous source checks before the final deadline check.
      // The frozen worker's write then has no asynchronous preparation gap.
      if(beforeSend()!==undefined)throw fail('SEND_PREPARATION_INVALID');
      fresh(verifiedReply);send();return result;
    },
    async recordReport(reportSha256){
      if(!used||reported||!hex(reportSha256,64))throw fail('REPORT_CONSUMED_OR_INVALID');reported=true;
      const value=await request({action:'record_report',report_sha256:reportSha256});
      if(!value||typeof value!=='object'||Array.isArray(value)||value.action!=='record_report'||value.operation_id!==operationId||value.phase!=='bootstrap_report_recorded'||value.independent_acceptance!==false||value.automatic_retry!==false)throw fail('REPORT_REPLY');
      socket.destroy();return {independentAcceptance:false};
    },
    close(){socket.destroy();},
  });
}
