// Candidate only. Fixed read-only HA service registry; no subscriptions or calls.
const http=require('node:http');
const MAX_BODY=262144;
function registryPresence(raw){
 const catalogue=JSON.parse(raw.toString('utf8'));if(!Array.isArray(catalogue)||catalogue.length>2048)throw Error('invalid_response');const domains=new Set();let found=false;
 for(const row of catalogue){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='domain,services'||typeof row.domain!=='string'||!/^[a-z0-9_]{1,128}$/.test(row.domain)||domains.has(row.domain)||!row.services||typeof row.services!=='object'||Array.isArray(row.services))throw Error('invalid_response');domains.add(row.domain);if(row.domain==='public_bindings'&&Object.hasOwn(row.services,'call')){if(!row.services.call||typeof row.services.call!=='object'||Array.isArray(row.services.call))throw Error('invalid_response');found=true;}}
 return found;
}
const ERRORS=new Set(['starting','transport_unconfirmed','response_refused','invalid_response','scope_expired','scope_revoked','connection_unverified']);
class ServiceProbe{
 #token;#revoked;#request;#clock;#timers;#publish;#expiry;#pending=null;#interval=null;#expiryTimer=null;#generation=0;#running=false;#lastSuccess=null;
 constructor(token,publish,{expiry,revoked=()=>false,request=http.request,clock=Date.now,timers={setInterval,clearInterval,setTimeout,clearTimeout}}={}){
  if(typeof token!=='string'||!token||typeof publish!=='function'||!Number.isFinite(expiry))throw Error('fixed_probe_binding_refused');
  this.#token=token;this.#revoked=revoked;this.#publish=publish;this.#expiry=expiry;this.#request=request;this.#clock=clock;this.#timers=timers;
 }
 #snapshot(error=null,available=null){const at=new Date(this.#clock()).toISOString();return {schema_version:1,source:'HA_fixed_readonly_service_registry',observed_at:at,state:error?'unknown':'observed',collection_error:error,service:'public_bindings.call',registered:available,last_success:this.#lastSuccess,lookup:'fixed_service_registry_membership',not_service_execution:true,not_handler_or_provider_health:true};}
 #emit(error=null,available=null){if(error&&!ERRORS.has(error))error='transport_unconfirmed';if(!error)this.#lastSuccess={observed_at:new Date(this.#clock()).toISOString(),registered:available};try{this.#publish(this.#snapshot(error,available));}catch{this.#running=false;this.#generation++;this.#timers.clearInterval(this.#interval);this.#timers.clearTimeout(this.#expiryTimer);const pending=this.#pending;this.#pending=null;pending?.destroy();}}
 #expired(){return this.#revoked()||this.#clock()+5000>=this.#expiry*1000;}
 #blockedReason(){return this.#revoked()?'scope_revoked':'scope_expired';}
 #query(){
  if(!this.#running||this.#pending)return;
  if(this.#expired()){this.stop(this.#blockedReason());return;}
  const generation=this.#generation;let pending,settled=false;
  const finish=(error,registered=null)=>{if(settled)return;settled=true;if(this.#pending===pending)this.#pending=null;if(generation!==this.#generation||!this.#running)return;if(this.#expired()){this.stop(this.#blockedReason());return;}this.#emit(error,registered);};
  try{
   pending=this.#request({host:'127.0.0.1',port:8123,path:'/api/services',method:'GET',agent:false,headers:{Authorization:'Bearer '+this.#token}},response=>{
    let bytes=0;const chunks=[];response.on('data',c=>{bytes+=c.length;if(bytes>MAX_BODY){finish('invalid_response');pending.destroy();return;}chunks.push(c)});
    response.on('error',()=>finish('transport_unconfirmed'));response.on('end',()=>{if(response.statusCode!==200){finish('response_refused');return;}try{finish(null,registryPresence(Buffer.concat(chunks)));}catch{finish('invalid_response');}});
   });
   this.#pending=pending;pending.setTimeout(3000,()=>{finish('transport_unconfirmed');pending.destroy();});pending.on('error',()=>finish('transport_unconfirmed'));pending.end();
  }catch{finish('transport_unconfirmed');}
 }
 start(){if(this.#running)return;if(this.#expired()){this.#emit(this.#blockedReason());return;}this.#running=true;this.#generation++;this.#emit('starting');if(!this.#running)return;this.#interval=this.#timers.setInterval(()=>this.#query(),60000);this.#expiryTimer=this.#timers.setTimeout(()=>this.stop('scope_expired'),Math.max(1,this.#expiry*1000-this.#clock()-5000));this.#query();}
 stop(reason='connection_unverified'){
  this.#running=false;this.#generation++;this.#timers.clearInterval(this.#interval);this.#timers.clearTimeout(this.#expiryTimer);const pending=this.#pending;this.#pending=null;pending?.destroy();this.#emit(reason);
 }
}
module.exports={ServiceProbe,registryPresence,MAX_BODY};
