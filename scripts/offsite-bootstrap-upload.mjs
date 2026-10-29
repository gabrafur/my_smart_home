// One automatic-settings generation request. No credential discovery,
// configuration mutation, service control, retention or upload retry.
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {waitForBackupManagerIdle} from './offsite-backup.mjs';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const failure=code=>Object.assign(new Error('first backup generation is unconfirmed; automatic retry is disabled'),
  {code:`BOOTSTRAP_UPLOAD_${code}`,automaticRetry:false});
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const generationType='backup/generate_with_automatic_settings';
const profileType='backup/metadata_profile';
const endpoint='ws://127.0.0.1:8123/api/websocket';
const canonical=value=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))]))
  :Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):value);
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join()===names.slice().sort().join();
const empty=value=>Array.isArray(value)&&value.length===0;
const noRetention=value=>keys(value,['copies','days'])&&value.copies===null&&value.days===null;

// Facts must come from the sealed native producer, never backup/config/info.
// This verifier neither discovers settings nor grants execution authority.
export function savedBackupProfileSha256(value){
  if(!keys(value,['schema_version','scope','agent_id','password_configured','provider_protected',
    'include_database','include_all_addons','include_addons','include_folders','delete_permanently','native_retention'])||
    value.schema_version!==1||value.scope!=='ha_saved_backup_profile_v1'||
    typeof value.agent_id!=='string'||!/^onedrive\.[A-Za-z0-9_-]{1,128}$/.test(value.agent_id)||
    value.password_configured!==true||value.provider_protected!==true||value.delete_permanently!==false||
    value.include_database!==false||value.include_all_addons!==false||
    !empty(value.include_addons)||!empty(value.include_folders))throw failure('PROFILE');
  const retention=value.native_retention;
  if(!keys(retention,['all_agents_covered','global','agents'])||retention.all_agents_covered!==true||
    !noRetention(retention.global)||!Array.isArray(retention.agents)||retention.agents.length<1||
    retention.agents.length>64)throw failure('PROFILE');
  const ids=new Set();
  for(const agent of retention.agents){
    if(!keys(agent,['agent_id','copies','days'])||typeof agent.agent_id!=='string'||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(agent.agent_id)||ids.has(agent.agent_id)||
      agent.copies!==null||agent.days!==null)throw failure('PROFILE');
    ids.add(agent.agent_id);
  }
  if(!ids.has(value.agent_id))throw failure('PROFILE');
  return digest(canonical(value));
}

function session({token,WebSocket,timeoutMs}) {
  let socket,closed=false,authSent=false,authenticated=false,pending=null,sequence=0,generationUsed=false;
  let resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const stop=code=>{
    if(closed)return;closed=true;clearTimeout(handshakeTimer);token=null;
    const error=failure(code);rejectReady(error);
    if(pending){const old=pending;pending=null;clearTimeout(old.timer);old.reject(error);}
    socket?.terminate();
  };
  const handshakeTimer=setTimeout(()=>stop('AUTH_TIMEOUT'),timeoutMs);
  try{socket=new WebSocket(endpoint);}catch{stop('CONNECT');}
  if(socket){
    socket.on('error',()=>stop('TRANSPORT'));
    socket.on('close',()=>stop('CLOSED'));
    socket.on('message',raw=>{
      if(closed)return;
      if(Buffer.byteLength(raw)>1048576){stop('REPLY_SIZE');return;}
      let value;try{value=JSON.parse(raw);}catch{stop('REPLY_JSON');return;}
      if(!value||typeof value!=='object'||Array.isArray(value)){stop('REPLY_SCHEMA');return;}
      if(value.type==='auth_required'&&!authSent&&!authenticated){
        authSent=true;
        try{socket.send(JSON.stringify({type:'auth',access_token:token}),error=>{if(error)stop('AUTH_WRITE');});}
        catch{stop('AUTH_WRITE');}
      }else if(value.type==='auth_ok'&&authSent&&!authenticated){
        authenticated=true;token=null;clearTimeout(handshakeTimer);resolveReady();
      }else if(value.type==='result'&&authenticated&&pending&&value.id===pending.id&&typeof value.success==='boolean'){
        const old=pending;pending=null;clearTimeout(old.timer);
        if(value.success)old.resolve(value.result);
        else old.reject(failure('RESULT'));
      }else stop('REPLY_SCHEMA');
    });
  }
  function reserve(request,budget=timeoutMs,explicitId=null){
    if(closed||!authenticated||pending||socket.readyState!==1)throw failure('NOT_READY');
    if(budget<=0)throw failure('NOT_READY');
    const id=explicitId??++sequence,text=JSON.stringify({id,...request});
    let resolve,reject;
    const response=new Promise((yes,no)=>{resolve=yes;reject=no;});
    // The Root round trip can outlive the response timer. Observe rejection
    // immediately; awaiting it below still propagates the original failure.
    response.catch(()=>{});
    const deadline=performance.now()+Math.min(timeoutMs,budget);
    pending={id,resolve,reject,timer:setTimeout(()=>stop('RESPONSE_TIMEOUT'),Math.min(timeoutMs,budget))};
    const slot=pending;
    const check=()=>{if(closed||pending!==slot||socket.readyState!==1||performance.now()>=deadline)throw failure('NOT_READY');};
    return {text,response,validate(validate){
      check();
      if(validate()!==true)throw failure('SOURCE_CHANGED');
      check();
    },write(){
      check();
      try{socket.send(text,error=>{if(error)stop('WRITE');});}catch{stop('WRITE');throw failure('WRITE');}
    }};
  }
  return {
    ready,
    async info(budget){const r=reserve({type:'backup/info'},budget);r.write();return r.response;},
    async profile(){const r=reserve({type:profileType});r.write();return r.response;},
    async generate({channel,bundleSha256,validateSource,checkProfile}){
      if(generationUsed)throw failure('CONSUMED');generationUsed=true;
      // Allocate the refresh before the generation ID so actual HA requests
      // stay ordered while Root binds the exact future generation frame.
      const refreshId=++sequence,generationId=++sequence;
      const text=JSON.stringify({id:generationId,type:generationType});
      const requestSha256=digest(text),deadline=performance.now()+timeoutMs;
      let r;
      try{
        const admission=await channel.dispatchRemote({bundleSha256,requestSha256,
          prepareBeforeSend:async()=>{
            const query=reserve({type:profileType},deadline-performance.now(),refreshId);
            query.write();checkProfile(await query.response);
          },beforeSend:()=>{
            validateSource();
            r=reserve({type:generationType},deadline-performance.now(),generationId);
            if(r.text!==text)throw failure('FRAME_CHANGED');
          },send:()=>r.write()});
        const value=await r.response;
        if(!value||typeof value!=='object'||Object.keys(value).join()!=='backup_job_id'||
          typeof value.backup_job_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value.backup_job_id))throw failure('JOB_UNCONFIRMED');
        return {admission,jobId:value.backup_job_id,requestSha256};
      }catch{stop('GENERATION_UNCONFIRMED');throw failure('GENERATION_UNCONFIRMED');}
    },
    close(){stop('CLOSED');},
  };
}

// Only the sealed worker supplies these dependencies. A prepared bundle or a
// caller-provided function never substitutes for the inherited Root channel.
export function prepareBootstrapUpload({channel,bundleSha256,token,WebSocket,validateSource,recordLocalReport,
  expectedProfileSha256,
  timeoutMs=30000,readinessTimeoutMs=60000,pollIntervalMs=3000}={}) {
  if(!channel||typeof channel.dispatchRemote!=='function'||typeof channel.recordReport!=='function'||
    !validHash(bundleSha256)||typeof token!=='string'||!token||token.length>8192||
    typeof WebSocket!=='function'||typeof validateSource!=='function'||typeof recordLocalReport!=='function'||
    !validHash(expectedProfileSha256)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||
    !Number.isSafeInteger(readinessTimeoutMs)||readinessTimeoutMs<1||readinessTimeoutMs>120000||
    !Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>readinessTimeoutMs)throw failure('INPUT');
  let used=false;
  const validate=()=>{
    if(validateSource()!==true)throw failure('SOURCE_CHANGED');
    return true;
  };
  const checkProfile=value=>{if(savedBackupProfileSha256(value)!==expectedProfileSha256)throw failure('SOURCE_CHANGED');};
  return Object.freeze({async run(){
    if(used)throw failure('CONSUMED');used=true;
    let connection;
    try{
      validate();
      connection=session({token,WebSocket,timeoutMs});
      await connection.ready;
      checkProfile(await connection.profile());
      await waitForBackupManagerIdle({timeoutMs:readinessTimeoutMs,pollIntervalMs,
        request:(_token,request,budget)=>{
          if(request.type!=='backup/info')throw failure('READINESS_METHOD');
          return connection.info(budget);
        }});
      const {admission,jobId,requestSha256}=await connection.generate({channel,bundleSha256,validateSource:validate,checkProfile});
      if(!admission||typeof admission.operationId!=='string'||!/^[a-f0-9]{32}$/.test(admission.operationId)||
        admission.automaticRetry!==false)throw failure('ADMISSION');
      const report=Object.freeze({schema_version:1,state:'generation_response_unverified',operation_id:admission.operationId,
        bundle_sha256:bundleSha256,request_sha256:requestSha256,backup_job_id_sha256:digest(jobId),
        automatic_settings_profile_sha256:expectedProfileSha256,
        automatic_retry:false,independent_acceptance:false,remote_effect_proven:false,policy_promoted:false});
      // The private data record must be durable before its hash is handed to
      // Root. Its content is a report, never an encrypted-backup acceptance.
      const receipt=await recordLocalReport(Object.freeze({jobId,report}));
      if(receipt!==true)throw failure('LOCAL_REPORT_UNCONFIRMED');
      await channel.recordReport(digest(JSON.stringify(report)));
      return {jobId,report};
    }catch(error){
      if(typeof error?.code==='string'&&/^BOOTSTRAP_UPLOAD_[A-Z_]+$/.test(error.code))throw error;
      throw failure('RUN_UNCONFIRMED');
    }finally{connection?.close();}
  }});
}
