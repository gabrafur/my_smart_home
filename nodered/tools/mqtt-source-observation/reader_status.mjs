/* Closed Root reader metadata and clock facts. No operational thresholds here. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical,uint,schema} from './consumer_protocol.mjs';
export class ReaderStatusInvalid extends Error{
 constructor(code='reader_status_invalid'){super(code);this.code=code;this.name='ReaderStatusInvalid';}
}
const need=(ok,code)=>{if(!ok)throw new ReaderStatusInvalid(code);};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const closed=(v,keys)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&canonical(Object.keys(v).sort())===canonical([...keys].sort()));
function fixedRead(path,limit){
 let fd;
 try{fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);
  const b=Buffer.alloc(limit+1),n=fs.readSync(fd,b,0,b.length,null);need(n<=limit,'consumer_clock_unavailable');
  return b.subarray(0,n).toString('ascii');
 }catch{throw new ReaderStatusInvalid('consumer_clock_unavailable');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function clockDomain(boot,offsets){
 need(typeof boot==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\n?$/.test(boot),'consumer_clock_unavailable');
 const rows=new Set();
 for(const line of offsets.trim().split('\n')){
  const m=/^\s*(monotonic|boottime)\s+([+-]?\d+)\s+([+-]?\d+)\s*$/.exec(line);
  need(m&&!rows.has(m[1])&&BigInt(m[2])===0n&&BigInt(m[3])===0n,'consumer_clock_unavailable');rows.add(m[1]);
 }
 need(rows.size===2,'consumer_clock_unavailable');
 return createHash('sha256').update(boot.trim(),'ascii').digest('hex');
}
export function localClock(){
 return {domain:clockDomain(fixedRead('/proc/sys/kernel/random/boot_id',128),fixedRead('/proc/self/timens_offsets',1024)),nowNs:process.hrtime.bigint()};
}
const keys=['schema_version','source','reader_instance_sha256','clock_domain_sha256','reader_started_boottime_ns',
 'reader_observed_boottime_ns','reader_observed_monotonic_ns','authorization_state','source_authorized','last_intake_state',
 'last_successful_intake_completed_boottime_ns','accepted_frames','reader_sessions','faults','full24h_proven','all_event_latency_proven'];
export function decodeReaderStatus(input,clock){
 try{
  need(Buffer.isBuffer(input)&&input.length<=8192&&input.every(n=>n<128));
  const text=input.toString('ascii'),v=JSON.parse(text);need(canonical(v)===text);
  need(v.schema_version===1||v.schema_version===2);closed(v,[...keys,...(v.schema_version===2?['source_facts']:[])]);
  need(v.source==='fixed_mqtt_metadata_reader'&&hex(v.reader_instance_sha256)&&hex(v.clock_domain_sha256));
  need(['active','disabled','expired','revoked','invalid'].includes(v.authorization_state));
  need(v.source_authorized===true||v.source_authorized===false||v.source_authorized===null);
  need((v.authorization_state==='active')===(v.source_authorized===true));
  need(['waiting','accepted','duplicate','unknown'].includes(v.last_intake_state));
  const started=uint(v.reader_started_boottime_ns,64),observed=uint(v.reader_observed_boottime_ns,64),mono=uint(v.reader_observed_monotonic_ns,64);
  need(started<=observed);
  if(v.last_successful_intake_completed_boottime_ns!==null){
    const complete=uint(v.last_successful_intake_completed_boottime_ns,64);need(started<=complete&&complete<=observed);
  }
  uint(v.accepted_frames);uint(v.reader_sessions);
  const source=v.schema_version===2?v.source_facts:null;
  if(source!==null){
    closed(source,['epoch','instance_sha256','wire_version','started_boottime_ns','emitted_boottime_ns','covered_before_ns','closed','identity_state']);
    need(uint(source.epoch)>0n&&hex(source.instance_sha256)&&[1,2,3].includes(source.wire_version));
    need(typeof source.closed==='boolean'&&(!source.closed||source.wire_version>=2));
    need(['verified_live','verified_exited'].includes(source.identity_state));
    need(v.last_successful_intake_completed_boottime_ns!==null&&uint(v.accepted_frames)>0n);
    const complete=uint(v.last_successful_intake_completed_boottime_ns,64);
    if(source.started_boottime_ns!==null)need(uint(source.started_boottime_ns,64)<=complete);
    if(source.emitted_boottime_ns!==null){
      const emitted=uint(source.emitted_boottime_ns,64);need(emitted<=complete);
      if(source.started_boottime_ns!==null)need(uint(source.started_boottime_ns,64)<=emitted);
    }
    if(source.covered_before_ns!==null){
      const before=uint(source.covered_before_ns,64);need(source.wire_version===3&&before<=complete);
      if(source.emitted_boottime_ns!==null)need(before<=uint(source.emitted_boottime_ns,64));
      if(source.started_boottime_ns!==null)need(before>=uint(source.started_boottime_ns,64));
    }
  }
  closed(v.faults,schema.faults);schema.faults.forEach(k=>uint(v.faults[k]));
  need(v.full24h_proven===false&&v.all_event_latency_proven===false);
  const local=clock??localClock();
  need(hex(local.domain)&&typeof local.nowNs==='bigint'&&local.nowNs>=0n&&local.nowNs<(1n<<64n),'consumer_clock_unavailable');
  const same=local.domain===v.clock_domain_sha256,ordered=same&&local.nowNs>=mono;
  const age=ordered?local.nowNs-mono:null;
  return {schema_version:1,reader_instance_sha256:v.reader_instance_sha256,authorization_state:v.authorization_state,
   source_authorized:v.source_authorized,clock_domain_matches:same,clock_ordered:ordered,
   status_age_ns:age===null?null:age.toString(),status_age_ms:age===null?null:Number((age+999999n)/1000000n),
   faults:{...v.faults},last_intake_state:v.last_intake_state,accepted_frames:v.accepted_frames,reader_sessions:v.reader_sessions,
   reader_status_schema:v.schema_version,clock_domain_sha256:v.clock_domain_sha256,
   reader_observed_boottime_ns:v.reader_observed_boottime_ns,
   source_facts:source===null?null:structuredClone(source)};
 }catch(error){if(error instanceof ReaderStatusInvalid)throw error;throw new ReaderStatusInvalid();}
}
