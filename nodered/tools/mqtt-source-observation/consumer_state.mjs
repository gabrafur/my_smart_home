/* Durable source-protocol accounting. No house policy or latency thresholds. */
import {canonical,digest,decodeEnvelope,ackFor,receiptFacts,sumCounts,zeroCounts,uint,schema} from './consumer_protocol.mjs';
import {validateCheckpoint} from './canvas_checkpoint.mjs';
export class ConsumerInvalid extends Error {
  constructor(code='consumer_state_invalid'){super(code);this.name='ConsumerInvalid';this.code=code;}
}
const need=(ok,code)=>{if(!ok)throw new ConsumerInvalid(code);};
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const closed=(x,keys)=>need(x!==null&&typeof x==='object'&&!Array.isArray(x)&&canonical(Object.keys(x).sort())===canonical([...keys].sort()));
export function initialState(){
  return {version:1,last_packet:'0',last_packet_sha:null,last_receipt:'0',last_receipt_sha:null,pending:null,
    received_counts:zeroCounts(),acked_counts:zeroCounts(),report_clock_domain_id:null,clock_domain_changes:'0',
    timing:Object.fromEntries(schema.kinds.map(k=>[k,{observed:'0',timed:'0',timing_unknown:'0',max_upper_ns:null}]))};
}
export function validateState(state){
  try{
    need(state?.version===1||state?.version===2);
    closed(state,['version','last_packet','last_packet_sha','last_receipt','last_receipt_sha','pending',
      'received_counts','acked_counts','report_clock_domain_id','clock_domain_changes','timing',
      ...(state.version===2?['canvas_checkpoint']:[])]);
    // During a pure protocol transition the previous canvas record may lag
    // the new receipt. The store requires an exact anchor on disk and binds
    // its replacement before the combined state can be persisted or ACKed.
    if(state.version===2){
      validateCheckpoint(state.canvas_checkpoint);
      need(uint(state.canvas_checkpoint.receipt_id,64)<=uint(state.last_receipt,64));
    }
    const sent=uint(state.last_packet,64),done=uint(state.last_receipt,64);
    need(done<=sent&&sent<=done+1n);
    need((sent===0n&&state.last_packet_sha===null)||(sent>0n&&hex(state.last_packet_sha)));
    need((done===0n&&state.last_receipt_sha===null)||(done>0n&&hex(state.last_receipt_sha)));
    need(state.report_clock_domain_id===null||hex(state.report_clock_domain_id));uint(state.clock_domain_changes);
    sumCounts(state.acked_counts,zeroCounts());sumCounts(state.received_counts,zeroCounts());
    if(state.pending!==null){
      need(sent===done+1n&&state.pending.body.bucket_id===state.last_packet&&state.pending.sha256===state.last_packet_sha);
      const previous=state.pending.body.previous_ack;
      need(done===0n?previous===null:previous!==null&&digest(previous)===state.last_receipt_sha);
      const body={packet:state.pending,last_ack:previous,acked_buckets:state.last_receipt,
        acked_counts:state.acked_counts,source_clock_domain_id:state.report_clock_domain_id};
      decodeEnvelope(canonical({schema_version:1,body,sha256:digest(body)}));
      need(canonical(state.received_counts)===canonical(sumCounts(state.acked_counts,state.pending.body.aggregate.counts)));
    }else{
      need(sent===done);need(canonical(state.received_counts)===canonical(state.acked_counts));
    }
    closed(state.timing,schema.kinds);
    for(const kind of schema.kinds){
      const row=state.timing[kind];closed(row,['observed','timed','timing_unknown','max_upper_ns']);
      need(uint(row.observed)===uint(row.timed)+uint(row.timing_unknown));
      need(row.observed===state.acked_counts.stats[kind].observed);
      need(uint(row.timed)<=uint(state.acked_counts.stats[kind].timed));
      if(uint(row.timed)>0n)uint(row.max_upper_ns,64);else need(row.max_upper_ns===null);
    }
    return state;
  }catch(error){
    if(error instanceof ConsumerInvalid)throw error;
    throw new ConsumerInvalid();
  }
}
export function transition(previous,raw){
  let envelope;
  try{envelope=decodeEnvelope(raw);}catch{throw new ConsumerInvalid('producer_report_invalid');}
  const body=envelope.body;
  if(previous===null)need(body.acked_buckets==='0','consumer_history_missing');
  else validateState(previous);
  const state=structuredClone(previous??initialState()),facts=[];
  if(state.report_clock_domain_id!==null&&state.report_clock_domain_id!==body.source_clock_domain_id)
    state.clock_domain_changes=(uint(state.clock_domain_changes)+1n).toString();
  state.report_clock_domain_id=body.source_clock_domain_id;
  if(body.last_ack!==null){
    const receipt=body.last_ack,id=uint(receipt.bucket_id,64),old=uint(state.last_receipt,64);
    need(id>=old,'producer_counter_reversed');
    if(id>old){
      need(id===old+1n&&state.pending!==null&&receipt.bucket_id===state.pending.body.bucket_id,'uncorrelated_producer_receipt');
      let observed;
      try{observed=receiptFacts(state.pending,receipt);}catch{throw new ConsumerInvalid('producer_receipt_invalid');}
      state.acked_counts=sumCounts(state.acked_counts,state.pending.body.aggregate.counts);
      state.last_receipt=receipt.bucket_id;state.last_receipt_sha=digest(receipt);
      for(const kind of schema.kinds){
        const source=observed.by_kind[kind],row=state.timing[kind];
        for(const key of ['observed','timed','timing_unknown'])row[key]=(uint(row[key])+uint(source[key])).toString();
        if(source.source_to_consumer_upper_ns!==null){
          const n=uint(source.source_to_consumer_upper_ns,64);
          row.max_upper_ns=row.max_upper_ns===null?n.toString():(n>uint(row.max_upper_ns,64)?n.toString():row.max_upper_ns);
        }
      }
      state.pending=null;facts.push(observed);
    }else need(state.last_receipt_sha===digest(receipt),'producer_receipt_conflict');
  }else need(state.last_receipt==='0','producer_counter_reversed');
  need(body.acked_buckets===state.last_receipt&&canonical(body.acked_counts)===canonical(state.acked_counts),'producer_accounting_conflict');
  if(body.packet!==null){
    const packet=body.packet,id=uint(packet.body.bucket_id,64),old=uint(state.last_packet,64);
    need(id>=old,'producer_counter_reversed');
    if(id>old){
      need(state.pending===null&&id===old+1n,'uncorrelated_producer_packet');
      state.received_counts=sumCounts(state.received_counts,packet.body.aggregate.counts);
      state.last_packet=packet.body.bucket_id;state.last_packet_sha=packet.sha256;state.pending=packet;
    }else need(state.pending!==null&&packet.sha256===state.pending.sha256,'producer_packet_conflict');
  }else need(state.pending===null,'producer_packet_missing');
  validateState(state);
  return {state,ack:state.pending===null?null:ackFor(state.pending),
    changed:previous===null||canonical(state)!==canonical(previous),receipt_facts:facts,
    full24h_proven:false,all_event_latency_proven:false};
}
