// Additive v1 diagnostics, no mutation of the existing eleven-tool contract.
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
import {route as originalRoute, brokerCall, extraDescriptors} from './expanded-server.mjs';
const change_id={type:'string',pattern:'^[a-f0-9]{32}$'};
const definitions=[
 ['maintenance_capabilities','Discover implemented capabilities, schema version and explicit unsupported maintenance operations.',{}],
 ['host_diagnostics','Read CPU sample, memory, swap, temperature, throttling, filesystem space and inodes. Each evidence has source, age, errors and coverage. No historical trend is implied.',{}],
 ['service_diagnostics','Read safe Docker state, healthcheck and restart count for one permitted service. Running is not proof of functional readiness.',{service:{type:'string',enum:['homeassistant','nodered','mosquitto']}}],
 ['operation_status','Inspect an existing operation ID without applying or retrying it. Source hashes do not prove deployment. Unknown restart outcomes require reconciliation.',{change_id}],
 ['change_validate','Check syntax of a prepared JavaScript source edit without executing it. Unsupported formats stay unknown. No imports, configuration load, actuators, deployment or persisted approval gate.',{change_id}],
];
export const diagnosticDescriptors=definitions.map(([name,description,properties])=>({name,description,
 inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},...properties},required:['host',...Object.keys(properties)]},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}));
const names=new Set(diagnosticDescriptors.map(row=>row.name));
export async function route(request, read, audit, invoke=brokerCall){
 if(request?.method==='tools/list'){
  const response=await originalRoute(request,read,audit,invoke);
  if(response?.result)response.result.tools.push(...diagnosticDescriptors);
  return response;
 }
 if(request?.method!=='tools/call'||!names.has(request?.params?.name))return originalRoute(request,read,audit,invoke);
 // Reuse the existing envelope validation, audit and safe error handling.
 // A temporary alias is not exposed to the broker or caller.
 const alias={...request,params:{...request.params,name:extraDescriptors[0].name}};
 const sink=audit??(row=>fs.writeSync(2,JSON.stringify(row)+'\n'));
 return originalRoute(alias,read,row=>sink({...row,tool:request.params.name}),
  ()=>invoke(request.params));
}
async function serve(){
 let pending=Buffer.alloc(0),count=0,start=Date.now();
 for await(const chunk of process.stdin){
  // Input chunks are bounded by Node. Accumulate by line, never byte-by-byte.
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
