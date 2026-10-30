import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {correctCapabilities,finalizeOperatingPolicy} from './event_projection.mjs';

const host={type:'string',enum:['raspberry']};
const operation_id={type:'string',pattern:'^[a-f0-9]{32}$'};
const schemas={
 submit:{host,operation_id,task:{type:'string',enum:['repair_health_summary']}},
 status:{host,operation_id},result:{host,operation_id},
 reconcile:{host,operation_id,result_hash:{type:'string',pattern:'^[a-f0-9]{64}$'}},
 revoke:{host},capabilities:{host},
};
export const descriptors=Object.entries(schemas).map(([action,properties])=>({
 name:'codex_repair_'+action,
 description:({submit:'Submit the single approved repair_health_summary task to the fixed existing Raspberry thread. No caller prompt, command, path, privilege or thread override. Same ID never replays an uncertain dispatch.',
 status:'Observe only the recorded turn; an unavailable observation or notLoaded thread is not completion. After expiry return cached evidence without dispatch.',
 result:'Return the persisted enum-only terminal result and its hash. Record centrally before reconciliation.',
 reconcile:'Acknowledge the exact persisted terminal result hash. Cannot release an uncertain or running dispatch.',
 revoke:'Block new fixed repair submissions; preserve running turn and receipts. Does not revoke other pre-existing tools.',
 capabilities:'Read root-approved repair catalogue, actual admission/expiry and extension boundaries. Unknown future tasks require reviewed root catalogue and approval.'})[action],
 inputSchema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)},
 annotations:{readOnlyHint:['status','result','capabilities'].includes(action),
  destructiveHint:['submit','revoke'].includes(action),idempotentHint:true,openWorldHint:false},
}));

export function makeRepairRoute(prior,invoke,dispatch,audit=()=>{}) {
 return async q=>{
  if(q?.method==='tools/call'&&descriptors.some(x=>x.name===q.params?.name))
   return dispatch({...q,params:{...q.params,name:'project_files'}},undefined,
    row=>audit({...row,tool:q.params.name}),()=>invoke(q.params));
  const result=await prior(q);
  if(q?.method==='tools/list'&&result?.result?.tools)
   result.result.tools.push(...structuredClone(descriptors));
  if(q?.method==='tools/call'&&q.params?.name==='maintenance_capabilities'&&!result?.result?.isError){
   let events=null;
   let catalogue=null;
   try{
    const listed=await prior({jsonrpc:'2.0',id:'repair_current_catalogue',method:'tools/list',params:{}});
    if(Array.isArray(listed?.result?.tools))
     catalogue=[...new Set([...listed.result.tools.map(t=>t.name),...descriptors.map(t=>t.name)])];
   }catch{/* A missing catalogue remains unknown; never infer tool availability. */}
   try{
    const r=await prior({jsonrpc:'2.0',id:'repair_event_status',method:'tools/call',
     params:{name:'events_status',arguments:{host:'raspberry'}}});
    if(!r?.result?.isError)events=r.result.structuredContent??
     JSON.parse(r.result.content.find(x=>x.type==='text').text);
   }catch{/* Closed unknown projection; no raw error or callback export. */}
   const operatingObservationTime=Date.now();
   const project=value=>{
    const corrected=correctCapabilities(value,events,operatingObservationTime);
    if(catalogue&&corrected?.evidence?.data){
     corrected.evidence.data.tool_names=catalogue;
     corrected.evidence.data.listed_tool_count=catalogue.length;
     corrected.evidence.data.tool_catalogue_source='actual_frontend_descriptors_not_authorization';
     if(corrected.evidence.data.operating_policy_v1)
      corrected.evidence.data.operating_policy_v1=finalizeOperatingPolicy(corrected.evidence.data.operating_policy_v1,catalogue,operatingObservationTime);
    }
    return corrected;
   };
   if(result?.result?.structuredContent)
    result.result.structuredContent=project(result.result.structuredContent);
   for(const item of result?.result?.content??[])if(item.type==='text'){
    try{item.text=JSON.stringify(project(JSON.parse(item.text)));}catch{}
   }
  }
  return result;
 };
}

async function serve(){
 const {makeFullRoute}=await import('./task-server.mjs');
 const {brokerCall,route:toolRoute}=await import('./expanded-server.mjs');
 const audit=row=>fs.writeSync(2,JSON.stringify(row)+'\n');
 const route=makeRepairRoute(makeFullRoute(brokerCall,audit),brokerCall,toolRoute,audit);
 let pending=Buffer.alloc(0),count=0,start=Date.now();
 for await(const chunk of process.stdin)for(const byte of chunk){
  if(pending.length>=16384)return;
  pending=Buffer.concat([pending,Buffer.from([byte])]);
  if(byte!==10)continue;
  if(Date.now()-start>=60000){start=Date.now();count=0;}
  if(++count>60)return;
  let q;try{q=JSON.parse(pending.toString())}catch{q=null}
  pending=Buffer.alloc(0);const r=await route(q);
  if(r&&!process.stdout.write(JSON.stringify(r)+'\n'))
   await new Promise(resolve=>process.stdout.once('drain',resolve));
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 serve().catch(()=>{process.exitCode=1;});
