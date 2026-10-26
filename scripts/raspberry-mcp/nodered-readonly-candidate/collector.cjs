'use strict';
// Fixed Raspberry Node-RED read scope; HTTP writes are auth/session revocation only.
const http=require('node:http');
const MAX=8*1024*1024;
function call(method,path,body,token,max=MAX) {
 if(!((method==='GET'&&['/flows','/settings'].includes(path)) || (method==='POST'&&['/auth/token','/auth/revoke'].includes(path))))throw Error('fixed_request_refused');
 return new Promise((resolve,reject)=>{
  let settled=false,deadline;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(deadline);error?reject(error):resolve(value)};
  const data=body===null?null:JSON.stringify(body),req=http.request({host:'UNBOUND_NODERED_HOST',port:1880,path,method,agent:false,headers:{'Node-RED-API-Version':'v2',...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...(token?{Authorization:'Bearer '+token}:{})}},res=>{
   const chunks=[];let n=0;
   res.on('data',b=>{n+=b.length;if(n>max)req.destroy(Error('fixed_response_limit'));else chunks.push(b)});
   res.on('error',()=>finish(Error('fixed_transport_failed')));
   res.on('aborted',()=>finish(Error('fixed_transport_failed')));
   res.on('end',()=>{try{finish(null,{status:res.statusCode,data:n?JSON.parse(Buffer.concat(chunks)):null})}catch{finish(Error('fixed_response_invalid'))}});
  });
  // request.setTimeout alone starts only after TCP connects. This deadline
  // covers DNS/connect/TLS/header/body as one fixed request, without retry.
  deadline=setTimeout(()=>{req.destroy(Error('fixed_transport_deadline'));finish(Error('fixed_transport_deadline'))},8000);deadline.unref?.();
  req.setTimeout(5000,()=>req.destroy(Error('fixed_transport_timeout')));
  req.on('error',()=>finish(Error('fixed_transport_failed')));req.end(data);
 });
}
async function collect(username,password){let token=null,flows=null,version=null,revision=null,error=null,revoked=null,at=null;
 try{
  if(typeof username!=='string'||!/^[A-Za-z0-9_.@-]{1,64}$/.test(username)||typeof password!=='string'||password.length<1||password.length>4096)throw Error('credential_binding_invalid');
  const login=await call('POST','/auth/token',{client_id:'node-red-admin',grant_type:'password',scope:'read',username,password},null,16384);
  if(login.status!==200||typeof login.data?.access_token!=='string'||login.data.access_token.length>4096)throw Error('read_authentication_refused');token=login.data.access_token;
  const current=await call('GET','/flows',null,token);at=new Date().toISOString();
  if(current.status!==200||!Array.isArray(current.data?.flows)||current.data.flows.length>8192)throw Error('runtime_flows_unavailable');
  flows=current.data.flows;revision=typeof current.data.rev==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(current.data.rev)?current.data.rev:null;
  const settings=await call('GET','/settings',null,token,262144);
  if(settings.status!==200||typeof settings.data?.version!=='string'||!/^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(settings.data.version))throw Error('runtime_version_unavailable');version=settings.data.version;
 }catch(e){flows=null;error=['credential_binding_invalid','read_authentication_refused','runtime_flows_unavailable','runtime_version_unavailable'].includes(e.message)?e.message:'fixed_NodeRED_collection_failed'}
 finally{password=null;if(token){try{const r=await call('POST','/auth/revoke',{token},token,16384);revoked=r.status>=200&&r.status<300}catch{revoked=false}}token=null;}
 // A read-only session whose revocation is uncertain is never retried or cached.
 if(revoked===false){flows=null;error='read_session_revocation_unconfirmed'}
 return {source:'fixed_NodeRED_Admin_API_read_scope',observed_at:at||new Date().toISOString(),collection_error:error,session_revoked:revoked,flows,runtime_version:version,runtime_revision:revision,coverage:['GET_flows_and_settings_only','read_scope_authentication','no_credentials_exported','no_deployment_service_calls_injection_or_context_history']};
}
module.exports={collect};
