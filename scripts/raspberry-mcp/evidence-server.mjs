import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {route as diagnosticRoute} from './diagnostics-server.mjs';
import {route as legacyRoute,brokerCall} from './expanded-server.mjs';
const upgraded=new Set(['backup_results','log_summary','host_diagnostics']);
async function dispatch(request,read,audit,invoke=brokerCall){
 if(request?.method==='tools/list'){
  const response=await diagnosticRoute(request,read,audit,invoke);
  for(const tool of response?.result?.tools??[]){
   if(tool.name==='backup_results')tool.description='Read sanitized Git/offsite result, reason, pending requests, lock evidence and last success. Per-source timestamps and coverage; absence of restore evidence is unknown. No backup execution.';
   if(tool.name==='log_summary'){
    tool.description='Read bounded log evidence with representative allowlisted message templates, categories, recurrence, timestamps and pagination. Private payloads and unsupported message text are omitted. Reuse window_end and digest as expected_digest for subsequent pages.';
    Object.assign(tool.inputSchema.properties,{
     window_minutes:{type:'integer',enum:[15,60,240]},window_end:{type:'string',maxLength:40},
     offset:{type:'integer',minimum:0,maximum:1000},expected_digest:{type:'string',pattern:'^[a-f0-9]{64}$'}
    });
   }
  }
  return response;
 }
 if(request?.method!=='tools/call'||!upgraded.has(request?.params?.name))return diagnosticRoute(request,read,audit,invoke);
 const alias={...request,params:{...request.params,name:'project_files'}};
 const sink=audit??(row=>fs.writeSync(2,JSON.stringify(row)+'\n'));
 return legacyRoute(alias,read,row=>sink({...row,tool:request.params.name}),()=>invoke(request.params));
}
export async function route(request,read,audit,invoke=brokerCall){
 const response=await dispatch(request,read,audit,invoke);
 if(request?.method==='tools/call'&&response?.result?.structuredContent&&!response.result.isError){
  const data=response.result.structuredContent;
  const observed=data.observed_at??new Date().toISOString();
  const normalized={schema_version:'1.1.0',source:`mcp.${request.params.name}`,
   age_seconds:Math.max(0,(Date.now()-Date.parse(observed))/1000),collection_error:null,
   coverage:['tool_specific_evidence_and_limits','observation_time_not_deployment_proof'],...data,observed_at:observed};
  response.result.structuredContent=normalized;
  response.result.content=[{type:'text',text:JSON.stringify(normalized)}];
 }
 return response;
}
async function serve(){
 let pending=Buffer.alloc(0),count=0,start=Date.now();
 for await(const chunk of process.stdin){
  let offset=0;
  while(offset<chunk.length){
   const end=chunk.indexOf(10,offset),stop=end<0?chunk.length:end+1;
   if(pending.length+stop-offset>16384)return;
   pending=Buffer.concat([pending,chunk.subarray(offset,stop)]);offset=stop;
   if(end<0)continue;
   if(Date.now()-start>=60000){start=Date.now();count=0;}
   if(++count>60)return;
   let request;try{request=JSON.parse(pending.toString('utf8'));}catch{request=null;}
   pending=Buffer.alloc(0);
   const response=await route(request);
   if(response&&!process.stdout.write(JSON.stringify(response)+'\n'))await new Promise(resolve=>process.stdout.once('drain',resolve));
  }
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)serve().catch(()=>{process.exitCode=1;});
