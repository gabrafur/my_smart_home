// Fixed host-local Node-RED address already bound on this Raspberry; no container exec.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
function request(method,path,data,token){return new Promise((resolve,reject)=>{
 const body=data?JSON.stringify(data):null;
 const req=http.request({host:'${NODE_RED_PRIVATE_HOST}',port:1880,path,method,headers:{'Node-RED-API-Version':'v2','Node-RED-Deployment-Type':'nodes',...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{}),...(token?{Authorization:'Bearer '+token}:{})}},res=>{
 let out='';res.on('data',c=>{out+=c;if(out.length>16000000)req.destroy(Error('response_limit'))});
 res.on('end',()=>{try{resolve({status:res.statusCode,data:out?JSON.parse(out):null})}catch{reject(Error('invalid_response'))}});
 });req.setTimeout(12000,()=>req.destroy(Error('outcome_unknown')));req.on('error',()=>reject(Error('outcome_unknown')));req.end(body);
})}
(async()=>{let token=null,submitted=false;let proof={source:'NodeRED Admin API',automatic_retry:false};
 try{
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 if(!['read','deploy'].includes(input.action))throw Error('action_refused');
 const login=await request('POST','/auth/token',{client_id:'node-red-admin',grant_type:'password',scope:input.action==='read'?'read':'*',username:process.env.NODE_RED_ADMIN_USER||'admin',password:input.password});
 if(login.status!==200||typeof login.data?.access_token!=='string')throw Error('login_refused');token=login.data.access_token;
 let current=await request('GET','/flows',null,token);
 if(current.status!==200||!Array.isArray(current.data?.flows))throw Error('read_refused');
 proof.loaded_sha256=digest(current.data.flows);proof.revision=current.data.rev;
 if(input.action==='deploy'){
  if(proof.loaded_sha256!==input.expected_loaded_sha256)throw Error('loaded_baseline_changed');
  if(!Array.isArray(input.flows)||digest(input.flows)!==input.proposed_loaded_sha256)throw Error('proposal_changed');
  submitted=true;const changed=await request('POST','/flows',{rev:current.data.rev,flows:input.flows},token);
  if(changed.status!==200&&changed.status!==204)throw Error(changed.status===409?'loaded_revision_conflict':'deployment_unconfirmed');
  current=await request('GET','/flows',null,token);
  if(current.status!==200||!Array.isArray(current.data?.flows))throw Error('verification_unconfirmed');
  proof.loaded_sha256=digest(current.data.flows);proof.revision=current.data.rev;
  if(proof.loaded_sha256!==input.proposed_loaded_sha256)throw Error('loaded_result_mismatch');
 }
 proof.verified=true;
 }catch(e){proof.error=/^[a-z_]{1,80}$/.test(e.message)?e.message:'client_failed';proof.verified=false;}
 finally{if(token){try{const r=await request('POST','/auth/revoke',{token},token);proof.session_revoked=r.status>=200&&r.status<300}catch{proof.session_revoked=false;}}}
 proof.submitted=submitted;console.log(JSON.stringify(proof));
})().catch(()=>{console.log('{"error":"client_failed","automatic_retry":false}');process.exitCode=1});
