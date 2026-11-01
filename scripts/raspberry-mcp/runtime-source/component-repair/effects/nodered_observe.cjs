// Fixed readonly child. Only read-scope login, GET flows, and session revocation.
// Private scope data never leaves this process; only reviewed identity matches.
const fs=require('node:fs');
const {FixedNodeRedClient,selected}=require('./nodered_effect.cjs');
const {normalizedIdentity}=require('../attestation_model.cjs');
const need=(x,r)=>{if(!x)throw Error(r);};
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function fd(){const x=process.env.COMPONENT_AUTH_FD;need(typeof x==='string'&&/^[0-9]{1,4}$/.test(x)&&Number(x)>=3&&Number(x)<1024,'private_auth_descriptor_required');return Number(x);}
function bounded(descriptor,limit){const blocks=[];let size=0;for(;;){const b=Buffer.alloc(4096),n=fs.readSync(descriptor,b,0,b.length,null);if(!n)break;size+=n;need(size<=limit,'fixed_observation_input_limit');blocks.push(b.subarray(0,n));}return Buffer.concat(blocks);}
async function observe(request,client,clock=()=>Date.now()/1000){
 need(request&&Object.keys(request).sort().join(',')==='allowed_identities,component_id,nonce,operation_id'&&request.component_id==='observacao_host'&&/^[a-f0-9]{32}$/.test(request.operation_id)&&/^[a-f0-9]{32}$/.test(request.nonce)&&Array.isArray(request.allowed_identities)&&request.allowed_identities.length>0&&request.allowed_identities.length<=2&&request.allowed_identities.every(sha),'closed_observation_request');
 let result={source:'protected_NodeRED_read_session',component_id:request.component_id,operation_id:request.operation_id,nonce:request.nonce,state:'unknown',collection_error:'readonly_runtime_collection_failed',observed_at:clock(),loaded_sha256:null,identity_kind:'nodered_scoped_configuration_v1',session_revoked:true,functional_health:'unknown',automatic_retry:false};
 try{
  await client.loginReadOnly();const current=await client.configuration();const identity=normalizedIdentity(selected(current.flows,request.component_id));
  if(request.allowed_identities.includes(identity))result={...result,state:'observed',collection_error:null,loaded_sha256:identity,observed_at:clock()};
  else result.collection_error='loaded_scope_not_reviewed';
 }catch{result.collection_error='readonly_runtime_collection_failed';}
 finally{try{result.session_revoked=await client.revoke();}catch{result.session_revoked=false;}}
 if(!result.session_revoked)result={...result,state:'unknown',collection_error:'read_session_revocation_unconfirmed',loaded_sha256:null};
 return result;
}
async function main(){
 need(process.argv.length===2,'fixed_observer_arguments');const auth=fd(),secret=bounded(auth,8192);fs.closeSync(auth);const operator=JSON.parse(secret.toString('utf8'));secret.fill(0);
 need(operator&&Object.keys(operator).join(',')==='authentication','fixed_observation_operator');const request=JSON.parse(bounded(0,4096).toString('utf8'));const client=new FixedNodeRedClient(operator.authentication);operator.authentication=null;
 process.stdout.write(JSON.stringify(await observe(request,client))+'\n');
}
module.exports={observe};
if(require.main===module)main().catch(()=>{process.stdout.write('{"state":"unknown","collection_error":"readonly_child_unconfirmed","automatic_retry":false}\n');process.exitCode=1;});
