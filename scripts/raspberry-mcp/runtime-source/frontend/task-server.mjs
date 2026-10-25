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
  send:'Send bounded task instructions to an adapter-created task only. Shared serial gate with legacy sends; aggregate 48 sends per24h, 60s spacing and included subscription only. Same operation_id never replays uncertain input. Does not extend access or authorize household effects.',
  status:'Observe an adapter creation receipt or the exact recorded Codex turn. notLoaded is not completion. No raw history, tool output or private logs. Observation failure never permits restarting the task.',
  reconcile:'Acknowledge the exact terminal result hash after recording the result in the central checkpoint. Cannot release running or uncertain work. No send or execution.',
  revoke:'Stop new dynamic and legacy adapter sends while preserving receipts and observation. Does not interrupt a running turn, remove subscriptions or alter root policy.',
  list:'Read sanitized metadata for the two authorized existing Raspberry references and adapter-created threads. Partial coverage, stable checked pagination, recent activity ordering and separate latest-created/latest-executed identities. No global native history, private titles or invented opening links. notLoaded is not completion.',
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
