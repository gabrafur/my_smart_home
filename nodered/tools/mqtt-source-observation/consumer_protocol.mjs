/* Metadata protocol validation only. Policy thresholds belong to Node-RED. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const schema=Object.freeze(JSON.parse(readFileSync(new URL('./handoff_schema.json',import.meta.url),'utf8')));
const {kinds,stats,headers,faults}=schema;
export class ProtocolInvalid extends Error {
  constructor(){super('metadata_protocol_invalid');this.name='ProtocolInvalid';}
}
const need=ok=>{if(!ok)throw new ProtocolInvalid();};
export function canonical(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
export const digest=value=>createHash('sha256').update(canonical(value),'ascii').digest('hex');
export function uint(value,bits=128){
  need(typeof value==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(value));
  const n=BigInt(value);need(n<(1n<<BigInt(bits)));return n;
}
const hex=value=>need(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value));
const closed=(v,keys)=>need(v!==null&&typeof v==='object'&&!Array.isArray(v)&&canonical(Object.keys(v).sort())===canonical([...keys].sort()));
const timestamp=value=>{if(value!==null)uint(value,64);};
function counts(value){
  closed(value,[...headers,'faults','stats']);
  headers.forEach(k=>uint(value[k]));
  closed(value.faults,faults);faults.forEach(k=>uint(value.faults[k]));
  closed(value.stats,kinds);
  for(const kind of kinds){
    const row=value.stats[kind];closed(row,stats);stats.forEach(k=>uint(row[k]));
    need(uint(row.expected)===uint(row.observed)+uint(row.missing));
    need(uint(row.observed)===uint(row.timed)+uint(row.timing_unknown));
    need(uint(row.missing)===uint(row.source_dropped)+uint(row.transport_missing));
  }
}
function nonempty(c){
  return headers.some(k=>uint(c[k])>0n)||faults.some(k=>uint(c.faults[k])>0n)
    ||kinds.some(k=>stats.some(s=>uint(c.stats[k][s])>0n));
}
function aggregate(value){
  closed(value,['clock_domain_id','clock_domain_conflict','first_reader_ns','last_reader_ns','counts','oldest_source_ns','max_socket_ns']);
  need(typeof value.clock_domain_conflict==='boolean');
  if(value.clock_domain_conflict)need(value.clock_domain_id===null);else hex(value.clock_domain_id);
  counts(value.counts);need(nonempty(value.counts));
  uint(value.first_reader_ns,64);uint(value.last_reader_ns,64);
  if(!value.clock_domain_conflict)need(uint(value.first_reader_ns,64)<=uint(value.last_reader_ns,64));
  for(const key of ['oldest_source_ns','max_socket_ns']){
    closed(value[key],kinds);
    for(const kind of kinds){
      const known=uint(value.counts.stats[kind].timed)>0n;
      need((value[key][kind]!==null)===known);timestamp(value[key][kind]);
    }
  }
  if(!value.clock_domain_conflict){
    for(const v of Object.values(value.oldest_source_ns))
      if(v!==null)need(uint(v,64)<=uint(value.last_reader_ns,64));
  }
}
function receipt(value){
  closed(value,['bucket_id','sha256','ack_at_ns','ack_clock_domain_id','publication_to_ack_ns','clock_ordered','source_to_ack']);
  need(uint(value.bucket_id,64)>0n);hex(value.sha256);uint(value.ack_at_ns,64);hex(value.ack_clock_domain_id);
  need(typeof value.clock_ordered==='boolean');
  if(value.clock_ordered)uint(value.publication_to_ack_ns,64);else need(value.publication_to_ack_ns===null);
  closed(value.source_to_ack,kinds);
  for(const kind of kinds){
    const row=value.source_to_ack[kind];closed(row,['observed','timed','timing_unknown','upper_ns']);
    need(uint(row.observed)===uint(row.timed)+uint(row.timing_unknown));
    if(uint(row.timed)>0n){need(value.clock_ordered);uint(row.upper_ns,64);}
    else need(row.upper_ns===null);
  }
}
function packet(value,last,acked){
  closed(value,['schema_version','body','sha256']);need(value.schema_version===1);hex(value.sha256);
  need(digest(value.body)===value.sha256);
  const body=value.body;closed(body,['bucket_id','aggregate','published_at_ns','publisher_clock_domain_id','previous_ack']);
  need(uint(body.bucket_id,64)===acked+1n);uint(body.published_at_ns,64);hex(body.publisher_clock_domain_id);
  need(canonical(body.previous_ack)===canonical(last));aggregate(body.aggregate);
}
export function decodeEnvelope(input){
  try{
    let raw;
    if(Buffer.isBuffer(input)){
      need(input.length<=schema.report_limit&&input.every(n=>n<128));raw=input.toString('ascii');
    }else{
      need(typeof input==='string'&&input.length<=schema.report_limit&&/^[\x00-\x7f]*$/.test(input));raw=input;
    }
    const value=JSON.parse(raw);need(canonical(value)===raw);
    closed(value,['schema_version','body','sha256']);need(value.schema_version===1);hex(value.sha256);
    need(digest(value.body)===value.sha256);
    const body=value.body;closed(body,['packet','last_ack','acked_buckets','acked_counts','source_clock_domain_id']);
    hex(body.source_clock_domain_id);counts(body.acked_counts);
    const acked=uint(body.acked_buckets,64);
    if(body.last_ack!==null){receipt(body.last_ack);need(uint(body.last_ack.bucket_id,64)===acked);}
    else need(acked===0n);
    if(body.packet!==null)packet(body.packet,body.last_ack,acked);
    return value;
  }catch(error){
    if(error instanceof ProtocolInvalid)throw error;
    throw new ProtocolInvalid();
  }
}
export function ackFor(packet){
  return {schema_version:1,bucket_id:packet.body.bucket_id,sha256:packet.sha256};
}
export function zeroCounts(){
  return {...Object.fromEntries(headers.map(k=>[k,'0'])),faults:Object.fromEntries(faults.map(k=>[k,'0'])),
    stats:Object.fromEntries(kinds.map(k=>[k,Object.fromEntries(stats.map(s=>[s,'0']))]))};
}
export function sumCounts(a,b){
  counts(a);counts(b);const result=zeroCounts();
  headers.forEach(k=>{result[k]=(uint(a[k])+uint(b[k])).toString();});
  faults.forEach(k=>{result.faults[k]=(uint(a.faults[k])+uint(b.faults[k])).toString();});
  kinds.forEach(k=>stats.forEach(s=>{result.stats[k][s]=(uint(a.stats[k][s])+uint(b.stats[k][s])).toString();}));
  counts(result);return result;
}
export function receiptFacts(receivedPacket,observedReceipt){
  try{
    receipt(observedReceipt);
    const body=receivedPacket.body,bucket=body.aggregate;
    need(observedReceipt.bucket_id===body.bucket_id&&observedReceipt.sha256===receivedPacket.sha256);
    const ordered=(observedReceipt.ack_clock_domain_id===body.publisher_clock_domain_id
      &&observedReceipt.ack_clock_domain_id===bucket.clock_domain_id&&!bucket.clock_domain_conflict
      &&uint(observedReceipt.ack_at_ns,64)>=uint(body.published_at_ns,64)
      &&uint(body.published_at_ns,64)>=uint(bucket.last_reader_ns,64));
    need(ordered===observedReceipt.clock_ordered);
    need(observedReceipt.publication_to_ack_ns===(ordered?(uint(observedReceipt.ack_at_ns,64)-uint(body.published_at_ns,64)).toString():null));
    const facts={};
    for(const kind of kinds){
      const row=observedReceipt.source_to_ack[kind],source=bucket.counts.stats[kind];
      const known=ordered&&bucket.oldest_source_ns[kind]!==null?source.timed:'0';
      const upper=uint(known)>0n?(uint(observedReceipt.ack_at_ns,64)-uint(bucket.oldest_source_ns[kind],64)).toString():null;
      need(row.observed===source.observed&&row.timed===known
        &&row.timing_unknown===(uint(source.observed)-uint(known)).toString()&&row.upper_ns===upper);
      // Exact ceiling conversion is safe as Number: uint64 ns / 1e6 < 2^53.
      const upperMs=upper===null?null:Number((uint(upper,64)+999999n)/1000000n);
      facts[kind]={observed:row.observed,timed:known,timing_unknown:row.timing_unknown,
        source_to_consumer_upper_ns:upper,source_to_consumer_upper_ms:upperMs};
    }
    return {bucket_id:body.bucket_id,clock_ordered:ordered,by_kind:facts,
      ack_at_ns:observedReceipt.ack_at_ns,clock_domain_sha256:observedReceipt.ack_clock_domain_id,
      full24h_proven:false,all_event_latency_proven:false};
  }catch(error){
    if(error instanceof ProtocolInvalid)throw error;
    throw new ProtocolInvalid();
  }
}
