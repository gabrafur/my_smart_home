/* Pure offline validation of the stopped consumer's durable metadata.
 * Reads only bounded stdin. Does not start Node-RED, inspect devices or write.
 */
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {canonical,digest} from './consumer_protocol.mjs';
import {validateState} from './consumer_state.mjs';
import {validateCheckpointAnchor} from './canvas_checkpoint.mjs';
export function inspectCheckpoint(raw){
 if(!Buffer.isBuffer(raw)||raw.length>131072||!raw.every(v=>v<128))throw Error('maintenance_checkpoint_invalid');
 const v=JSON.parse(raw.toString('ascii'));
 if(canonical(v)!==raw.toString('ascii')||v.schema_version!==1||digest(v.body)!==v.sha256
  ||canonical(Object.keys(v).sort())!==canonical(['body','schema_version','sha256']))throw Error('maintenance_checkpoint_invalid');
 validateState(v.body);validateCheckpointAnchor(v.body.canvas_checkpoint,v.body);
 if(v.body.canvas_checkpoint.schema_version!==2)throw Error('maintenance_checkpoint_invalid');
 return {acked_counts:v.body.acked_counts,canvas_checkpoint:v.body.canvas_checkpoint};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==2)throw Error('fixed_arguments');
  const raw=Buffer.alloc(131073);let used=0;
  while(used<raw.length){const n=fs.readSync(0,raw,used,raw.length-used,null);if(!n)break;used+=n;}
  console.log(JSON.stringify({state:'validated_stopped_consumer_checkpoint',accounting:inspectCheckpoint(raw.subarray(0,used))}));
 }catch{console.log('{"state":"unknown","collection_error":"maintenance_checkpoint_invalid"}');process.exitCode=1;}
}
