'use strict';
// Local fixed-target readonly proxy. Caller supplies only catalog offsets/opaque IDs.
const net=require('node:net'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFile}=require('node:child_process');
const {collect}=require('./collector.cjs'),{collectHA}=require('./ha-collector.cjs'),{createVirtualResources}=require('./virtual-resources.cjs'),kia=require('./kia_model.cjs'),runtimeFacts=require('./kia-runtime-facts.cjs');
const ROOT='/usr/local/lib/raspberry-nodered-diagnostics',PROJ='/mnt/data/docker';
const provider=createVirtualResources(),ID=/^[a-f0-9]{32}$/;
let cache=null,busy=false,lastAttempt=0,idle;
const safeCodes=new Set(['virtual_nodered_resource_unavailable','virtual_nodered_snapshot_unavailable','virtual_nodered_resource_budget_exhausted','virtual_nodered_document_limit_exceeded','runtime_collection_unavailable','collection_cooldown','read_session_revocation_unconfirmed','sidecar_busy','request_refused','integration_collection_unavailable']);
function fail(code){const e=Error(code);e.code=code;throw e;}
function fixedFile(p,limit){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>limit)fail('request_refused');const raw=fs.readFileSync(fd);if(raw.length>limit)fail('request_refused');return raw;}finally{fs.closeSync(fd)}}
function git(args,maxBuffer){return new Promise((resolve,reject)=>execFile('/usr/bin/git',['--no-optional-locks','-c','safe.directory='+PROJ,'-c','core.fsmonitor=false','--no-pager','-C',PROJ,...args],{timeout:4000,maxBuffer,encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',HOME:'/nonexistent'}},(error,stdout)=>error?reject(Error('public_source_unavailable')):resolve(stdout)));}
async function publicSource(head){if(typeof head!=='string'||!/^[a-f0-9]{40}$/.test(head))fail('runtime_collection_unavailable');const raw=await git(['show',head+':nodered/flows.json'],8*1024*1024);return{head,flows:JSON.parse(raw)}}
async function prepare(){const now=Date.now();if(cache&&now-Date.parse(cache.observed_at)<90000)return cache;
 if(now-lastAttempt<60000)fail('collection_cooldown');lastAttempt=now;
 if(fs.existsSync('/var/lib/raspberry-nodered-diagnostics/revoked'))fail('request_refused');
 const config=JSON.parse(fixedFile(ROOT+'/config.json',4096)),dir=process.env.CREDENTIALS_DIRECTORY;
 if(typeof dir!=='string'||!dir.startsWith('/run/credentials/'))fail('request_refused');
 let password=fixedFile(path.join(dir,'node-red-password'),4096).toString().trim();
 const r=await collect(config.node_red_username,password);password=null;
 if(r.collection_error||!r.flows)fail(r.collection_error==='read_session_revocation_unconfirmed'?r.collection_error:'runtime_collection_unavailable');
 const pub=await publicSource(config.approved_public_head);const at=r.observed_at,context={observed_at:at,now:new Date().toISOString(),runtime_version:r.runtime_version,public_head:pub.head,snapshot_nonce:crypto.randomBytes(16).toString('hex')};
 const seed=provider.seed(r.flows,pub.flows,context),kid=crypto.randomBytes(16).toString('hex');
 let integration;
 try{
  const identity=JSON.parse(fixedFile('/etc/raspberry-ha-notices/identity.json',4096));let token=fixedFile(path.join(dir,'ha-token'),4096).toString().trim();const ha=await collectHA(token,identity);token=null;
  let root;try{root=JSON.parse(fixedFile('/var/lib/raspberry-nodered-diagnostics/root-snapshot.json',16384))}catch{root={observed_at:null,sources:{},pending:{},timezone:{collection_error:'fixed_root_snapshot_unavailable'}}}
  const schedule=r.flows.find(n=>n.id==='daily_update_inventory_apply_schedule'),isLoaded=schedule?.type==='inject'&&schedule.crontab==='00 03 * * *',authorizes=schedule?.props?.some(p=>p.p==='_update_apply_authorized'&&p.v==='true'&&p.vt==='bool')===true;
  const localSources={};
  for(const [name,alias] of Object.entries({worker_result:'worker',merge:'merge',promotion:'promotion',promotion_public:'promotion-public'})){
   const row={observed_at:new Date().toISOString(),collection_error:null,data:null};
   try{const raw=fixedFile('/run/raspberry-nodered-diagnostics-inputs/'+alias,262144).toString('utf8');row.data=name==='worker_result'?raw.trim():JSON.parse(raw)}catch(e){if(e.code!=='ENOENT')row.collection_error='fixed_source_collection_failed'}
   localSources[name]=row;
  }
  const sources={...root.sources,...localSources,sensor:{observed_at:ha.observed_at,collection_error:ha.collection_error||ha.sensor?.collection_error,data:ha.sensor},pending:{observed_at:root.observed_at,collection_error:null,data:root.pending},schedule:{observed_at:at,collection_error:root.timezone?.collection_error||null,data:{crontab:schedule?.crontab,timezone:root.timezone?.timezone,loaded:isLoaded,authorizes_install:authorizes}}};
  integration=kia.project({now_unix_seconds:Date.now()/1000,sources});integration.runtime_manifest=ha.runtime_manifest;integration.runtime_facts=runtimeFacts.projectRuntimeFacts(ha.runtime_facts);integration.root_snapshot_observed_at=root.observed_at;integration.readonly=true;integration.collection_error=ha.collection_error||null;
 }catch{integration={source:'fixed_kia_updater_readonly_diagnostic',observed_at:new Date().toISOString(),collection_error:'integration_collection_unavailable',state:'unknown',coverage:['no_vehicle_data_or_calls','not_cycle_acceptance']}}
 const text=JSON.stringify(integration);if(Buffer.byteLength(text)>32768)fail('integration_collection_unavailable');
 cache={...seed,observed_at:at,kia_resource_id:kid,kia_text:text};return cache;
}
function closed(q,keys){if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).sort().join(',')!==keys.sort().join(',')||q.host!=='raspberry')fail('request_refused')}
async function handle(q){
 if(fs.existsSync('/var/lib/raspberry-nodered-diagnostics/revoked'))fail('request_refused');
 if(q?.op==='files'){
  closed(q,['op','host','offset']);if(!Number.isInteger(q.offset)||q.offset<0||q.offset>2)fail('request_refused');const s=await prepare();const rows=[{file_id:s.root_resource_id,path:'runtime://raspberry/nodered/flows',read_only:true,resource_kind:'runtime_readonly'},{file_id:s.kia_resource_id,path:'runtime://raspberry/integrations/kia-update',read_only:true,resource_kind:'runtime_readonly'}];return{files:rows.slice(q.offset),total:2,observed_at:s.observed_at,collection_error:null,coverage:['all_loaded_flows_and_nodes','sanitized_public_matching_parameters_and_source','opaque_resources_readonly_only']};
 }
 if(q?.op==='read'){
  closed(q,['op','host','file_id','offset']);if(!ID.test(q.file_id)||!Number.isInteger(q.offset)||q.offset<0||q.offset>262144)fail('request_refused');
  if(!cache||Date.now()-Date.parse(cache.observed_at)>=120000)fail('virtual_nodered_snapshot_unavailable');
  if(q.file_id===cache.kia_resource_id){const text=cache.kia_text;if(q.offset>text.length)fail('request_refused');return{path:'runtime://raspberry/integrations/kia-update',resource_kind:'runtime_readonly',deployment:'readonly_observation_no_execution',sha256:crypto.createHash('sha256').update(text).digest('hex'),text:text.slice(q.offset,q.offset+4000),next_offset:q.offset+4000<text.length?q.offset+4000:null,observed_at:cache.observed_at,age_seconds:(Date.now()-Date.parse(cache.observed_at))/1000,collection_error:null}}
  const r=provider.read({host:'raspberry',resource_id:q.file_id,offset:q.offset,limit:4000},new Date().toISOString());return{...r,path:'runtime://raspberry/nodered/resource/'+q.file_id,resource_kind:'runtime_readonly',deployment:'readonly_observation_no_execution',next_offset:r.pagination.next_offset};
 }
 fail('request_refused');
}
function main(){if(process.argv.length!==2||process.getuid()!==1001||process.env.LISTEN_FDS!=='1'||process.env.LISTEN_PID!==String(process.pid))fail('request_refused');
 const server=net.createServer(socket=>{let raw='',answered=false;socket.setTimeout(32000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',async b=>{if(answered)return socket.destroy();raw+=b.toString('utf8');if(Buffer.byteLength(raw)>1024)return socket.destroy();if(!raw.includes('\n'))return;answered=true;if(!raw.endsWith('\n')||raw.indexOf('\n')!==raw.length-1)return socket.destroy();clearTimeout(idle);if(busy)return socket.end(JSON.stringify({ok:false,error:'sidecar_busy'})+'\n');busy=true;try{const q=JSON.parse(raw);const result=await handle(q);const out=JSON.stringify({ok:true,result});if(Buffer.byteLength(out)>65536)throw Error('response_limit');socket.end(out+'\n')}catch(e){socket.end(JSON.stringify({ok:false,error:safeCodes.has(e.code)?e.code:'request_refused',automatic_retry:false})+'\n')}finally{busy=false;idle=setTimeout(()=>server.close(()=>process.exit(0)),30000);idle.unref()}})});server.listen({fd:3});idle=setTimeout(()=>server.close(()=>process.exit(0)),30000);idle.unref();}
module.exports={handle,main};if(require.main===module){try{main()}catch{process.exitCode=1}}
