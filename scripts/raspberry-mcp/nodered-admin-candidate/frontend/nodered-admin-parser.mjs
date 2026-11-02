// Candidate framing. Large legacy calls are never forwarded to legacy routes.
import {validEnvelope,RESPONSE_LIMIT,tools} from './nodered-admin-route.mjs';
export const LEGACY_LIMIT=16384, PREPARE_LIMIT=1048576;
export class FrameError extends Error {}
export class FrameParser {
  constructor({now=Date.now}={}) {this.now=now;this.start=now();this.count=0;this.pending=Buffer.alloc(PREPARE_LIMIT);this.bytes=0;}
  push(chunk) {
    const frames=[];
    let start=0;
    for(let i=0;i<chunk.length;i++) {
      if(chunk[i]!==10)continue;
      const part=chunk.subarray(start,i+1);this.#append(part);start=i+1;
      const raw=this.pending.subarray(0,this.bytes);this.bytes=0;
      const at=this.now();if(at-this.start>=60000){this.start=at;this.count=0;}
      if(++this.count>60)throw new FrameError('request_rate_limit');
      let q;try{q=JSON.parse(raw.toString('utf8'));}catch{q=null;}
      const largePrepare=q?.params?.name==='nodered_admin_prepare' && validEnvelope(q);
      if(raw.length>LEGACY_LIMIT&&!largePrepare)throw new FrameError('legacy_request_limit');
      frames.push({request:q,bytes:raw.length});
    }
    if(start<chunk.length)this.#append(chunk.subarray(start));
    return frames;
  }
  #append(chunk) {
    if(this.bytes+chunk.length>PREPARE_LIMIT)throw new FrameError('request_limit');
    chunk.copy(this.pending,this.bytes);this.bytes+=chunk.length;
  }
  end(){if(this.bytes)throw new FrameError('incomplete_request');}
}
export function encodeResponse(value) {
  const result=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(result)>RESPONSE_LIMIT)throw new FrameError('response_limit');
  return result;
}
export function encodeRoutedResponse(request, response) {
  // Preserve the previous encoding exactly for every legacy response, including
  // events and notices whose text+structuredContent can exceed the admin cap.
  return request?.method === 'tools/call' && tools.includes(request?.params?.name)
    ? encodeResponse(response) : JSON.stringify(response)+'\n';
}
