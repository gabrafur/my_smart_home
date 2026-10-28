/* Durable canvas decision data. Validates shape, binding and monotonic history;
 * operational decisions and thresholds remain in the canonical Node-RED graph.
 */
import {canonical,digest,uint,schema,sumCounts,zeroCounts} from './consumer_protocol.mjs';
export const MAX_CHECKPOINT_BYTES=65536,MAX_WINDOW_HISTORY=8;
export const phases=Object.freeze(['waiting','tracking','draining','passed','failed','unknown']);
export const reasons=Object.freeze(['not_started','collecting','duration_pending','draining','complete',
  'integrity_fault','latency_over_contract','receipt_gap','clock_unknown','reader_unknown',
  'policy_changed','history_missing','window_capacity','window_invalid','source_epoch_change']);
export const violations=Object.freeze(['missing','timing_unknown','integrity_faults','receipt_gaps',
  'clock_conflicts','over_contract_receipts','reader_unknown_observations']);
export class CheckpointInvalid extends Error{
  constructor(){super('canvas_checkpoint_invalid');this.name='CheckpointInvalid';this.code='canvas_checkpoint_invalid';}
}
const need=ok=>{if(!ok)throw new CheckpointInvalid();};
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const closed=(v,keys)=>need(v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&canonical(Object.keys(v).sort())===canonical([...keys].sort()));
const equal=(a,b)=>canonical(a)===canonical(b);
function counters(v){sumCounts(v,zeroCounts());return v;}
function leaves(v){return [...schema.headers.map(k=>v[k]),...schema.faults.map(k=>v.faults[k]),
  ...schema.kinds.flatMap(k=>schema.stats.map(s=>v.stats[k][s]))];}
function notLess(a,b){const old=leaves(b);return leaves(a).every((v,i)=>uint(v)>=uint(old[i]));}
function core(w){
  closed(w,['id_sha256','phase','reason','clock_domain_sha256','started_at_ns','observed_at_ns',
    'first_receipt_id','last_receipt_id','baseline_counts','acknowledged_counts',
    'max_upper_ns_by_kind','violations','policy','cut']);
  need(hex(w.id_sha256)&&hex(w.clock_domain_sha256)&&phases.includes(w.phase)&&reasons.includes(w.reason));
  need(uint(w.started_at_ns,64)<=uint(w.observed_at_ns,64));
  need(uint(w.first_receipt_id,64)<=uint(w.last_receipt_id,64));
  counters(w.baseline_counts);counters(w.acknowledged_counts);
  need(notLess(w.acknowledged_counts,w.baseline_counts));
  closed(w.max_upper_ns_by_kind,schema.kinds);
  for(const v of Object.values(w.max_upper_ns_by_kind))if(v!==null)uint(v,64);
  closed(w.violations,violations);Object.values(w.violations).forEach(v=>uint(v));
  closed(w.policy,['event_latency_ms','window_duration_ns']);
  uint(w.policy.event_latency_ms,64);uint(w.policy.window_duration_ns,64);
  if(w.cut!==null){
    closed(w.cut,['accepted_frames','source_emitted_at_ns']);uint(w.cut.accepted_frames);
    const source=uint(w.cut.source_emitted_at_ns,64);
    need(source>=uint(w.started_at_ns,64)&&source<=uint(w.observed_at_ns,64));
  }
}
export function validateCheckpoint(c){
  try{
    closed(c,['schema_version','sequence','previous_sha256','proposal_sha','receipt_id',
      'acknowledged_counts_sha256','window','history']);
    need(c.schema_version===1&&uint(c.sequence,64)>0n&&hex(c.proposal_sha)&&hex(c.acknowledged_counts_sha256));
    uint(c.receipt_id,64);need(uint(c.sequence,64)===1n?c.previous_sha256===null:hex(c.previous_sha256));
    core(c.window);need(uint(c.window.last_receipt_id,64)<=uint(c.receipt_id,64));
    need(Array.isArray(c.history)&&c.history.length<=MAX_WINDOW_HISTORY);
    c.history.forEach(core);
    need(new Set([...c.history.map(w=>w.id_sha256),c.window.id_sha256]).size===c.history.length+1);
    need(Buffer.byteLength(canonical(c),'ascii')<=MAX_CHECKPOINT_BYTES);
    return c;
  }catch{throw new CheckpointInvalid();}
}
export function validateCheckpointAnchor(c,state){
  validateCheckpoint(c);
  need(c.receipt_id===state.last_receipt&&c.acknowledged_counts_sha256===digest(state.acked_counts));
  need(notLess(state.acked_counts,c.window.acknowledged_counts));
}
export function bindCheckpoint(candidate,previous,state,proposal){
  try{
    validateCheckpointAnchor(candidate,state);need(candidate.proposal_sha===proposal);
    if(previous===null){need(candidate.sequence==='1'&&candidate.previous_sha256===null&&candidate.history.length===0);return candidate;}
    validateCheckpoint(previous);
    need(uint(candidate.sequence,64)===uint(previous.sequence,64)+1n&&candidate.previous_sha256===digest(previous));
    const a=candidate.window,b=previous.window;
    if(a.id_sha256!==b.id_sha256){
      need(equal(candidate.history,[...previous.history,b]));
    }else{
      need(equal(candidate.history,previous.history));
      for(const key of ['clock_domain_sha256','started_at_ns','first_receipt_id','baseline_counts','policy'])need(equal(a[key],b[key]));
      need(uint(a.observed_at_ns,64)>=uint(b.observed_at_ns,64)&&uint(a.last_receipt_id,64)>=uint(b.last_receipt_id,64));
      need(notLess(a.acknowledged_counts,b.acknowledged_counts));
      for(const key of violations)need(uint(a.violations[key])>=uint(b.violations[key]));
      for(const kind of schema.kinds){
        const old=b.max_upper_ns_by_kind[kind],now=a.max_upper_ns_by_kind[kind];
        if(old!==null)need(now!==null&&uint(now,64)>=uint(old,64));
      }
      if(b.cut!==null)need(equal(a.cut,b.cut));
    }
    return candidate;
  }catch{throw new CheckpointInvalid();}
}
export function encodeCheckpointCommit(proposal,checkpoint){
  need(hex(proposal));validateCheckpoint(checkpoint);
  const text=canonical({proposal_sha:proposal,checkpoint});
  need(Buffer.byteLength(text)<=MAX_CHECKPOINT_BYTES+128);
  return 'c1_'+Buffer.from(text,'ascii').toString('base64url');
}
export function decodeCommit(value){
  try{
    if(hex(value))return {proposal_sha:value,checkpoint:null};
    need(typeof value==='string'&&/^c1_[A-Za-z0-9_-]+$/.test(value)&&value.length<=90000);
    const encoded=value.slice(3),raw=Buffer.from(encoded,'base64url');
    need(raw.length<=MAX_CHECKPOINT_BYTES+128&&raw.toString('base64url')===encoded&&raw.every(x=>x<128));
    const text=raw.toString('ascii'),v=JSON.parse(text);closed(v,['proposal_sha','checkpoint']);
    need(canonical(v)===text&&hex(v.proposal_sha));validateCheckpoint(v.checkpoint);return v;
  }catch{throw new CheckpointInvalid();}
}
