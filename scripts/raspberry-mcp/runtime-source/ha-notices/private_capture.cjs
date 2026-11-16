'use strict';
const fs=require('node:fs'),{createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {projectPersistent}=require('./notification_text.cjs');
const {PrivateNoticeModel}=require('./private_notice_model.cjs');
const LIB='/usr/local/lib/raspberry-ha-notices',POLICY='/etc/raspberry-ha-notices/private-content-policy.json';
const REVOKED='/etc/raspberry-ha-notices/private-content-revoked';
const SOURCE_FILES=['notification_collector.cjs','notification_text.cjs','private_notice_model.cjs','private_capture.cjs','private_store.py','private_content_reader.py','private_reader_server.py','private_transport.py'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const equivalent=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const stamp=s=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
function rootBytes(file,maximum,policy=false){
 const pieces=file.split('/').filter(Boolean);let prefix='';
 for(const piece of pieces.slice(0,-1)){
  prefix+='/'+piece;const s=fs.lstatSync(prefix);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.mode&0o022)throw Error('private_source_parent_changed');
 }
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const before=fs.fstatSync(fd);
  if(!before.isFile()||before.uid!==0||before.nlink!==1||before.mode&(policy?0o027:0o022)||before.size<=0||before.size>maximum)throw Error('private_source_not_sealed');
  const raw=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(file);
  if(raw.length!==before.size||stamp(before)!==stamp(after)||stamp(before)!==stamp(named))throw Error('private_source_changed');
  return raw;
 }finally{fs.closeSync(fd);}
}
function notRevoked(){
 try{fs.lstatSync(REVOKED);throw Error('private_content_revoked');}catch(error){if(error.code!=='ENOENT')throw error;}
}
function requireActivePolicy(){
 notRevoked();const raw=rootBytes(POLICY,8192,true),p=JSON.parse(raw);
 const keys=['schema_version','enabled','revoked_at','host','project','allowed_tools','source_hashes','owner_approval_sha256','valid_until','max_chunk_codepoints','max_response_bytes'];
 if(!p||typeof p!=='object'||Array.isArray(p)||JSON.stringify(Object.keys(p).sort())!==JSON.stringify(keys.sort())||
    p.schema_version!==1||p.enabled!==true||p.revoked_at!==null||p.host!=='raspberry'||p.project!=='/mnt/data/docker'||
    JSON.stringify(p.allowed_tools)!==JSON.stringify(['ha_notification_content'])||typeof p.owner_approval_sha256!=='string'||
    !/^[a-f0-9]{64}$/.test(p.owner_approval_sha256)||p.owner_approval_sha256==='0'.repeat(64)||
    !(p.valid_until===null||typeof p.valid_until==='number'&&Number.isFinite(p.valid_until)&&Date.now()/1000<p.valid_until)||
    p.max_chunk_codepoints!==2048||p.max_response_bytes!==16000||
    !p.source_hashes||JSON.stringify(Object.keys(p.source_hashes).sort())!==JSON.stringify([...SOURCE_FILES].sort()))throw Error('private_content_access_not_activated');
 for(const name of SOURCE_FILES)if(hash(rootBytes(LIB+'/'+name,65536))!==p.source_hashes[name])throw Error('private_source_pin_changed');
 if(!rootBytes(POLICY,8192,true).equals(raw))throw Error('private_policy_changed');
 notRevoked();if(p.valid_until!==null&&Date.now()/1000>=p.valid_until)throw Error('private_content_access_not_activated');
 return p;
}
class FixedStoreClient{
 call(verb,input){
  try{requireActivePolicy();}catch(error){error.before_dispatch=true;throw error;}
  if(!['observe-writer-state','load','commit'].includes(verb))throw Error('fixed_private_store_verb');
  const r=spawnSync('/usr/bin/python3',['-I','-S','-B',LIB+'/private_store.py',verb],
   {input:input===undefined?'':JSON.stringify(input),encoding:'utf8',timeout:3000,maxBuffer:8*1024*1024,
    env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},windowsHide:true});
  if(r.error||r.status!==0||Buffer.byteLength(r.stdout||'')>5*1024*1024)throw Error('private_store_reply_unconfirmed');
  requireActivePolicy();
  const result=JSON.parse(r.stdout);if(result.collection_error&&!['private_store_empty','private_store_not_created'].includes(result.collection_error))throw Error('private_store_unavailable');
  return result;
 }
 load(){return this.call('observe-writer-state');}
 commit(snapshot,expected_digest){return this.call('commit',{snapshot,expected_digest});}
}
class PrivateCapture{
 constructor(backend){this.backend=backend;this.model=null;this.digest=null;this.current=new Map();this.seenCurrent=false;this.connection={};this.error='awaiting_full_source_snapshot';this.uncertain=false;this.pending=null;}
 load(){try{const loaded=this.backend.load();this.model=new PrivateNoticeModel(loaded.snapshot);this.digest=loaded.digest;}catch(error){this.error=error.before_dispatch?'private_access_not_admitted':'private_store_load_failed';throw error;}}
 reconnect(){this.connection={};this.seenCurrent=false;this.error='awaiting_full_source_snapshot';}
 failure(){this.error='source_transport_unavailable';}
 observe(event,legacyRows,observedAt){
  if(!event||!['current','added','updated','removed'].includes(event.type)||!event.notifications||typeof event.notifications!=='object'||Array.isArray(event.notifications))throw Error('invalid_private_frame');
  // Reconciliation may restore a checkpoint, never the baseline of an old
  // transport connection. Reject deltas before even observing the store.
  const pendingBaseline=this.uncertain&&this.pending?.connection===this.connection&&this.pending.seenCurrent;
  if(!this.seenCurrent&&!pendingBaseline&&event.type!=='current')throw Error('private_full_snapshot_required');
  if(this.uncertain&&this.pending){
   const loaded=this.backend.load(),pending=this.pending;
   if(equivalent(loaded.snapshot,pending.snapshot)){
    this.model=new PrivateNoticeModel(loaded.snapshot);this.digest=loaded.digest;this.current=pending.current;this.seenCurrent=Boolean(this.seenCurrent||pending.connection===this.connection&&pending.seenCurrent);this.pending=null;
   }else if(loaded.digest===pending.previous_digest){
    // The fixed SQLite writer recovered/closed the previous transaction and
    // still holds the previous CAS digest. Keep the uncommitted observation
    // in the next checkpoint rather than losing it or resending its event.
    this.model=new PrivateNoticeModel(pending.snapshot);this.digest=loaded.digest;this.current=pending.current;this.seenCurrent=Boolean(this.seenCurrent||pending.connection===this.connection&&pending.seenCurrent);
   }else{this.error='private_store_changed_pending_requires_review';throw Error(this.error);}
   this.uncertain=false;
  }
  if(this.model===null){
   this.load();
   // After an uncertain commit, rebuild only from the retained protected DTOs.
   // The source transport must still supply a full frame on each connection.
   const s=this.model.snapshot();this.current=new Map(s.records.filter(r=>s.current[r.object_id]===r.revision).map(r=>[r.object_id,r]));
  }
  const candidate=event.type==='current'?new Map():new Map(this.current);
  for(const[rawId,value]of Object.entries(event.notifications)){
   if(!value||value.notification_id!==rawId)throw Error('invalid_private_frame');
   const id=hash(rawId);
   if(event.type==='removed')candidate.delete(id);
   else candidate.set(id,projectPersistent(value,observedAt,legacyRows.find(r=>r.id===id)?.source_provenance??null));
  }
  const refs=legacyRows.map(r=>({object_id:r.id,revision:r.revision}));
  const next=new PrivateNoticeModel(this.model.snapshot());next.applyCurrent([...candidate.values()],refs,observedAt);
  const attempt={connection:this.connection,snapshot:next.snapshot(),previous_digest:this.digest,current:candidate,seenCurrent:this.seenCurrent||event.type==='current'};
  try{
   const result=this.backend.commit(attempt.snapshot,this.digest);
   if(!['private_observation_committed','existing_observation_only'].includes(result.state)||!/^[a-f0-9]{64}$/.test(result.digest))throw Error('private_store_reply_unconfirmed');
   this.model=next;this.current=candidate;this.digest=result.digest;this.seenCurrent=true;this.error=null;this.pending=null;
  }catch(error){this.uncertain=error.before_dispatch!==true;if(this.uncertain)this.pending=attempt;this.error=error.before_dispatch?'private_access_not_admitted':'private_commit_unconfirmed_observe_same_store';throw error;}
 }
 collectionFailure(){if(!this.uncertain&&this.error!=='private_access_not_admitted')this.error='private_collection_failed';}
 status(now=Date.now()){
  return {source:'private_notice_capture_v1',observed_at:new Date(now).toISOString(),state:this.error?'unknown':'observed',
   collection_error:this.error,stored_revision_count:this.model?.state.records.length??null,
   pending_protected_checkpoint:this.pending!==null,
   untrusted_source_text:true,execution_authority:false,coverage:['persistent_notifications_only','no_private_text_in_public_status']};
 }
 events(now=Date.now()){
  const projection=this.model?.eventProjection()||{schema_version:1,events:[],current:[],sequence:0,evicted_events:0};
  return {...projection,source:'private_household_notice_event_references_v1',published_at:new Date(now).toISOString(),capture:this.status(now)};
 }
}
function createPrivateCapture(){requireActivePolicy();return new PrivateCapture(new FixedStoreClient());}
module.exports={PrivateCapture,FixedStoreClient,requireActivePolicy,createPrivateCapture,SOURCE_FILES};
