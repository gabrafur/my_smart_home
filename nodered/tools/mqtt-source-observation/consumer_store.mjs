/* Metadata-only prepare/commit storage. Caller holds a kernel flock descriptor.
 * Production CLI pins directories and roles; there is no arbitrary-path MCP API.
 */
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {canonical,digest,decodeEnvelope} from './consumer_protocol.mjs';
import {decodeReaderStatus} from './reader_status.mjs';
import {transition,validateState,ConsumerInvalid} from './consumer_state.mjs';
import {bindCheckpoint,validateCheckpointAnchor,CheckpointInvalid} from './canvas_checkpoint.mjs';
const LIMIT=131072,REPORT_LIMIT=65536;
export class StoreInvalid extends Error{
  constructor(code){super(code);this.name='StoreInvalid';this.code=code;}
}
const need=(ok,code='consumer_storage_invalid')=>{if(!ok)throw new StoreInvalid(code);};
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid,s.gid,s.nlink].map(String).join(':');
const stat=fd=>fs.fstatSync(fd,{bigint:true});
const mode=s=>Number(s.mode&0o777n);
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const closed=(v,keys)=>need(v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&canonical(Object.keys(v).sort())===canonical([...keys].sort()));
function parse(raw){
  try{
    need(raw.every(n=>n<128));const text=raw.toString('ascii'),value=JSON.parse(text);
    need(canonical(value)===text);return value;
  }catch(error){if(error instanceof StoreInvalid)throw error;throw new StoreInvalid('consumer_storage_invalid');}
}
function wrapper(body){return {schema_version:1,body,sha256:digest(body)};}
function unwrap(value){
  closed(value,['schema_version','body','sha256']);
  need(value.schema_version===1&&hex(value.sha256)&&digest(value.body)===value.sha256);
  return value;
}
export class ConsumerStore{
  constructor(directory,reportDirectory,{consumerUid=process.getuid(),consumerGid=process.getgid(),publisherUid=0,lockFd=8,ownOnly=false}={}){
    this.directory=path.resolve(directory);this.reportDirectory=path.resolve(reportDirectory);
    this.uid=consumerUid;this.gid=consumerGid;this.publisher=publisherUid;this.lockFd=lockFd;
    need(typeof ownOnly==='boolean','consumer_role_invalid');this.ownOnly=ownOnly;
    this.ownFd=null;this.reportFd=null;
    need(process.getuid()===consumerUid&&process.getgid()===consumerGid,'consumer_role_mismatch');
    need([consumerUid,consumerGid,publisherUid,lockFd].every(n=>Number.isInteger(n)&&n>=0)&&lockFd>=3&&lockFd<=255,'consumer_role_invalid');
    try{
      this.ownFd=this._directory(this.directory,this.uid,this.gid,0o700);
      if(!ownOnly)this.reportFd=this._directory(this.reportDirectory,this.publisher,this.gid,0o750);
      this._check();
    }catch(error){this.close();if(error instanceof StoreInvalid)throw error;throw new StoreInvalid('consumer_open_failed');}
  }
  _directory(name,uid,gid,bits){
    need(fs.realpathSync(name)===name,'consumer_parent_unsafe');
    const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    const s=stat(fd);
    if(!(s.isDirectory()&&s.uid===BigInt(uid)&&s.gid===BigInt(gid)&&mode(s)===bits)){
      fs.closeSync(fd);throw new StoreInvalid('consumer_parent_unsafe');
    }
    return fd;
  }
  _at(fd,name){return '/proc/self/fd/'+fd+'/'+name;}
  _safe(s,uid,gid,bits,limit){
    return s.isFile()&&s.nlink===1n&&s.uid===BigInt(uid)&&s.gid===BigInt(gid)&&mode(s)===bits&&s.size<=BigInt(limit);
  }
  _check(){
    const directories=[[this.directory,this.ownFd,this.uid,0o700]];
    if(!this.ownOnly)directories.push([this.reportDirectory,this.reportFd,this.publisher,0o750]);
    for(const[name,fd,uid,bits]of directories){
      need(fd!==null,'consumer_store_closed');
      const current=fs.lstatSync(name,{bigint:true}),bound=stat(fd);
      need(same(current,bound)&&current.isDirectory()&&current.uid===BigInt(uid)&&current.gid===BigInt(this.gid)&&mode(current)===bits,'consumer_parent_changed');
    }
    const locked=stat(this.lockFd),named=fs.lstatSync(this._at(this.ownFd,'lock'),{bigint:true});
    need(same(locked,named)&&this._safe(locked,this.uid,this.gid,0o600,0),'consumer_lock_unsafe');
    const info=fs.readFileSync('/proc/self/fdinfo/'+this.lockFd,'ascii');
    need(info.length<=8192&&/^lock:.*FLOCK.*ADVISORY.*WRITE/m.test(info),'consumer_lock_required');
  }
  _read(fd,name,uid,bits,limit,optional=false){
    this._check();let file;
    try{
      file=fs.openSync(this._at(fd,name),fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);
    }catch(error){
      if(optional&&error.code==='ENOENT')return null;
      throw new StoreInvalid('consumer_file_unavailable');
    }
    try{
      const before=stat(file);need(this._safe(before,uid,this.gid,bits,limit),'consumer_file_unsafe');
      const chunks=[];let size=0;
      while(true){
        const buffer=Buffer.alloc(Math.min(4096,limit+1-size)),n=fs.readSync(file,buffer,0,buffer.length,null);
        if(n===0)break;size+=n;need(size<=limit,'consumer_file_oversized');chunks.push(buffer.subarray(0,n));
      }
      need(identity(stat(file))===identity(before),'consumer_file_changed');
      return Buffer.concat(chunks);
    }finally{fs.closeSync(file);}
  }
  _write(name,value,limit=LIMIT){
    this._check();const raw=Buffer.from(canonical(value),'ascii');need(raw.length<=limit,'consumer_capacity_reached');
    const old=this._read(this.ownFd,name,this.uid,0o600,limit,true);
    if(old!==null&&old.equals(raw)){
      try{fs.fsyncSync(this.ownFd);}catch{throw new StoreInvalid('consumer_write_failed');}
      return false;
    }
    const temporary='.metadata-'+randomBytes(12).toString('hex')+'.tmp',target=this._at(this.ownFd,temporary);
    let fd=null,opened=null,renamed=false;
    try{
      fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      fs.fchmodSync(fd,0o600);opened=stat(fd);fs.writeFileSync(fd,raw);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
      this._check();fs.renameSync(target,this._at(this.ownFd,name));renamed=true;fs.fsyncSync(this.ownFd);
    }catch{throw new StoreInvalid('consumer_write_failed');}
    finally{
      if(fd!==null)fs.closeSync(fd);
      if(!renamed&&opened!==null){
        try{if(same(fs.lstatSync(target,{bigint:true}),opened))fs.unlinkSync(target);}catch(error){if(error.code!=='ENOENT')throw new StoreInvalid('consumer_cleanup_failed');}
      }
    }
    return true;
  }
  _state(){
    const raw=this._read(this.ownFd,'state.json',this.uid,0o600,LIMIT,true);
    if(raw===null)return null;
    let value;
    try{
      value=unwrap(parse(raw));validateState(value.body);
      if(value.body.version===2)validateCheckpointAnchor(value.body.canvas_checkpoint,value.body);
    }
    catch{throw new StoreInvalid('consumer_state_invalid');}
    return value;
  }
  readerStatus(){
    need(!this.ownOnly,'consumer_report_required');
    return decodeReaderStatus(this._read(this.reportFd,'reader-status.json',this.publisher,0o640,8192));
  }
  prepare(){
    need(!this.ownOnly,'consumer_report_required');
    const old=this._state();
    const report=decodeEnvelope(this._read(this.reportFd,'report.json',this.publisher,0o640,REPORT_LIMIT));
    const result=transition(old?.body??null,canonical(report));
    const plan={schema_version:1,base_state_sha:old?.sha256??null,report};
    const ticket=wrapper(plan);
    this._write('prepared.json',ticket);
    return {state:'prepared',proposal_sha:ticket.sha256,base_state_sha:plan.base_state_sha,source_report_sha:report.sha256,
      source_packet:result.state.pending,received_counts:result.state.received_counts,
      acknowledged_counts:result.state.acked_counts,receipt_facts:result.receipt_facts,
      canvas_checkpoint:old?.body.canvas_checkpoint??null,
      canvas_checkpoint_sha256:old?.body.canvas_checkpoint?digest(old.body.canvas_checkpoint):null,
      clock_domain_changes:result.state.clock_domain_changes,ack_intended:result.ack!==null,full24h_proven:false};
  }
  commit(proposalSha,checkpoint=null){
    need(!this.ownOnly,'consumer_report_required');
    need(hex(proposalSha),'consumer_proposal_invalid');
    const prepared=unwrap(parse(this._read(this.ownFd,'prepared.json',this.uid,0o600,LIMIT)));
    if(prepared.sha256!==proposalSha)return {state:'stale_prepare',ack_written:false,full24h_proven:false};
    const plan=prepared.body;closed(plan,['schema_version','base_state_sha','report']);
    need(plan.schema_version===1&&(plan.base_state_sha===null||hex(plan.base_state_sha)),'consumer_proposal_invalid');
    const old=this._state();
    if((old?.sha256??null)!==plan.base_state_sha)return {state:'stale_prepare',ack_written:false,full24h_proven:false};
    const result=transition(old?.body??null,canonical(plan.report));
    if(checkpoint!==null){
      try{
        bindCheckpoint(checkpoint,old?.body.canvas_checkpoint??null,result.state,proposalSha);
        result.state.version=2;result.state.canvas_checkpoint=structuredClone(checkpoint);validateState(result.state);
      }catch{throw new CheckpointInvalid();}
    }else need(old?.body.canvas_checkpoint===undefined,'canvas_checkpoint_required');
    // The canonical flow has received this exact proposal before invoking
    // commit. Account for it durably before exposing its ACK to the producer.
    const durable=wrapper(result.state);this._write('state.json',durable);
    let written=false;
    if(result.ack!==null)written=this._write('ack.json',result.ack,4096);
    return {state:'committed',state_sha:durable.sha256,
      canvas_checkpoint_sha256:checkpoint===null?null:digest(checkpoint),
      ack_written:written,ack_intended:result.ack!==null,full24h_proven:false};
  }
  prepareCheckpoint(){
    const old=this._state();need(old!==null,'consumer_history_missing');
    const proposal=digest({schema_version:1,operation:'canvas_checkpoint_only',base_state_sha:old.sha256});
    return {state:'checkpoint_prepared',proposal_sha:proposal,base_state_sha:old.sha256,
      receipt_id:old.body.last_receipt,acknowledged_counts:structuredClone(old.body.acked_counts),
      canvas_checkpoint:structuredClone(old.body.canvas_checkpoint??null),
      canvas_checkpoint_sha256:old.body.canvas_checkpoint?digest(old.body.canvas_checkpoint):null,
      ack_intended:false,full24h_proven:false};
  }
  commitCheckpoint(proposal,checkpoint){
    need(hex(proposal)&&checkpoint!==null,'consumer_proposal_invalid');
    const old=this._state();need(old!==null,'consumer_history_missing');
    const expected=digest({schema_version:1,operation:'canvas_checkpoint_only',base_state_sha:old.sha256});
    if(proposal!==expected)return {state:'stale_prepare',ack_written:false,ack_intended:false,full24h_proven:false};
    bindCheckpoint(checkpoint,old.body.canvas_checkpoint??null,old.body,proposal);
    const next=structuredClone(old.body);next.version=2;next.canvas_checkpoint=structuredClone(checkpoint);validateState(next);
    const durable=wrapper(next);this._write('state.json',durable);
    // This route may record a failed/unknown canvas decision after producer
    // revocation. It never reads producer data or writes/replays any ACK.
    return {state:'checkpoint_committed',state_sha:durable.sha256,canvas_checkpoint_sha256:digest(checkpoint),
      ack_written:false,ack_intended:false,full24h_proven:false};
  }
  snapshot(){const state=this._state();return state===null?null:structuredClone(state.body);}
  close(){
    for(const key of ['ownFd','reportFd']){
      const fd=this[key];if(fd!==null){fs.closeSync(fd);this[key]=null;}
    }
  }
}
