import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {makeAdminRoute} from './admin-server.mjs';
import {makeControlRoute} from './codex-control-server.mjs';
import {makeEventRoute} from './events-server.mjs';
import {makeRoute} from './notices-server.mjs';
import {route as legacy} from './durable-server.mjs';
import {route as toolRoute,brokerCall} from './expanded-server.mjs';

const id={type:'string',pattern:'^[a-f0-9]{32}$'};
const common={host:{type:'string',enum:['raspberry']},operation_id:id};
const schemas={
 create:{...common,task_key:{type:'string',pattern:'^[a-z][a-z0-9-]{2,63}$'},objective:{type:'string',minLength:1,maxLength:4000},acceptance:{type:'string',minLength:1,maxLength:1500}},
 send:{...common,task_id:id,text:{type:'string',minLength:1,maxLength:6000}},
 status:{...common,kind:{type:'string',enum:['creation','turn']}},
 reconcile:{...common,result_hash:{type:'string',pattern:'^[a-f0-9]{64}$'}},
 revoke:{host:common.host},
 list:{host:common.host,page_size:{type:'integer',minimum:1,maximum:16},
  cursor:{type:['string','null'],maxLength:512}},
};
export const descriptors=Object.entries(schemas).map(([action,properties])=>({
 name:'codex_task_'+action,
 description:({
  create:'Create one scoped task thread with fixed project and permissions. Uses the existing approved expiry; never accepts configuration, paths, commands or privilege overrides. Persist task identity centrally. Response loss is uncertain and is never replayed. Creation does not send the objective.',
  send:'Send bounded instructions to an adapter-created task. Separately approved workspace communication may use an existing thread UUID with hyphens removed as task_id, only if no registered task owns that ID. Exact same-owner Raspberry daemon and project required. Existing profiles remain unchanged: active turn uses steer with expected-turn CAS; idle uses start without overrides; notLoaded is refused. Shared serial gates, 48 sends/24h, 60s spacing, expiry and interface confirmations remain. Unknown delivery never replays. Communication does not expand execution authority or prove a reply.',
  status:'Observe a creation receipt or exact recorded turn. For separately approved workspace communication, may return a bounded sanitized agent reply proven later than delivery and an exact operation acknowledgement. Receiver turn completion is not proof of message acknowledgement or goal completion. No raw history, tool output or private logs. Observation failure never permits replay.',
  reconcile:'Acknowledge the exact terminal result hash after recording the result in the central checkpoint. Cannot release running or uncertain work. No send or execution.',
  revoke:'Stop new dynamic and legacy adapter sends while preserving receipts and observation. Does not interrupt a running turn, remove subscriptions or alter root policy.',
  list:'Read sanitized metadata for authorized references, adapter tasks and previously messaged workspace references. Reports separate workspace communication policy, admission and acknowledgement. Coverage remains partial; no global native enumeration, private titles or invented links. Receiver turn completion does not prove delegated goal execution; notLoaded is not completion.',
 })[action],
 inputSchema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)},
 annotations:{readOnlyHint:['status','list'].includes(action),destructiveHint:['create','send','revoke'].includes(action),idempotentHint:true,openWorldHint:false},
}));
export function makeTaskRoute(prior,invoke=brokerCall,audit=()=>{}){return async q=>{
 if(q?.method==='tools/call'&&descriptors.some(t=>t.name===q.params?.name))
  return toolRoute({...q,params:{...q.params,name:'project_files'}},undefined,row=>audit({...row,tool:q.params.name}),()=>invoke(q.params));
 const r=await prior(q);
 if(q?.method==='tools/list'&&r?.result?.tools)r.result.tools.push(...structuredClone(descriptors));
 return r;
};}
export function makeFullRoute(invoke=brokerCall,audit=()=>{}){
 return makeTaskRoute(makeAdminRoute(makeControlRoute(makeEventRoute(makeRoute(legacy,toolRoute,invoke,audit)),invoke),invoke),invoke,audit);
}
async function serve(){
 const audit=row=>fs.writeSync(2,JSON.stringify(row)+'\n');
 const route=makeFullRoute(brokerCall,audit);
 let pending=Buffer.alloc(0),count=0,start=Date.now();
 for await(const chunk of process.stdin){for(const byte of chunk){
  if(pending.length>=16384)return;
  pending=Buffer.concat([pending,Buffer.from([byte])]);
  if(byte!==10)continue;
  if(Date.now()-start>=60000){start=Date.now();count=0;}
  if(++count>60)return;
  let q;try{q=JSON.parse(pending.toString())}catch{q=null}
  pending=Buffer.alloc(0);const r=await route(q);
  if(r&&!process.stdout.write(JSON.stringify(r)+'\n'))await new Promise(resolve=>process.stdout.once('drain',resolve));
 }}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 serve().catch(()=>{process.exitCode=1;});
