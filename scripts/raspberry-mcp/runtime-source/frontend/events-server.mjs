import fs from 'node:fs';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const validRequestId=id=>Number.isSafeInteger(id)||typeof id==='string';
const protocolErrors={invalid_params:[-32602,'Invalid parameters'],forbidden:[-32024,'Forbidden'],not_found:[-32023,'NotFound'],challenge_failed:[-32015,'CallbackEndpointError']};
const socketPath='/run/raspberry-mcp-events/events.sock';

// Both closed payload variants are advertised; input scope and transport are unchanged.
const phase={enum:['added','updated','removed']};
const opaque={type:'string',pattern:'^[a-f0-9]{64}$'};
const timestamp={type:'string',maxLength:40,pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$'};
const count=(minimum=0)=>({type:'integer',minimum,maximum:256});
const closed=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const common={project:{enum:['/mnt/data/docker']},topic:{enum:['ha_notification']},source:{enum:['ha_persistent_notification']}};
export const summaryPayloadSchema=closed({...common,delivery_kind:{enum:['notification_summary_v1']},
 source_observed_at:{...timestamp,type:['string','null']},summary_as_of:timestamp,
 notifications:{type:'array',minItems:1,maxItems:8,items:closed({object_id:opaque,
  current_state:{enum:['current','removed','unknown']},current_revision:{...opaque,type:['string','null']},
  latest_known_phase:{enum:['added','updated','removed',null]},historical_order_ambiguous:{type:'boolean'},
  first_change_at:timestamp,last_change_at:timestamp,change_count:count(1),
  phase_counts:closed({added:count(),updated:count(),removed:count()}),
  transition_preview:{type:'array',minItems:1,maxItems:8,items:phase},transition_preview_omitted:count(),
  revisions_coalesced:count(),recovery_proven:{enum:[false]}})},
 covered_event_records:count(1),remaining_notification_groups:count(),recovery_proven:{enum:[false]},
 assistant_execution:{enum:['unknown']},history_semantics:{enum:['transition_history_not_current_incidents']}});
export const eventPayloadSchema={oneOf:[closed({...common,phase,object_id:opaque,revision:opaque}),summaryPayloadSchema]};
export const payloadContractMetadata={version:'notification_payload_contract_v1',schema_sha256:createHash('sha256').update(JSON.stringify(eventPayloadSchema)).digest('hex'),payload_variants:['individual_notification_v1','notification_summary_v1'],coverage:['loaded_frontend_descriptor_not_remote_client_cache','not_delivery_or_assistant_execution_proof']};

export const statusDescriptor={name:'events_status',description:'Read sanitized native event subscription/delivery health. Reports source freshness, delivery budgets and uncertain outcomes. Webhook acceptance is not proof of an assistant run. No callback URLs, keys, retries or mutations.',inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']}},required:['host']},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
export function eventCall(method,params){return new Promise((resolve,reject)=>{
 const raw=Buffer.from(JSON.stringify({method,params})+'\n');
 if(raw.length>16384){reject(Error('request_limit'));return;}
 const client=net.createConnection({path:socketPath});let buffer=Buffer.alloc(0),done=false;
 const timer=setTimeout(()=>finish(Error('event_service_timeout')),15000);
 function finish(error,result){if(done)return;done=true;clearTimeout(timer);client.destroy();error?reject(error):resolve(result);}
 client.once('connect',()=>client.write(raw));
 client.on('error',()=>finish(Error('event_service_unavailable')));
 client.on('end',()=>{if(!done)finish(Error('event_service_incomplete'));});
 client.on('data',chunk=>{
  if(buffer.length+chunk.length>32768)return finish(Error('event_service_output_limit'));
  buffer=Buffer.concat([buffer,chunk]);if(!buffer.includes(10))return;
  try{const reply=JSON.parse(buffer.toString('utf8'));if(reply.ok!==true){const reason=Object.hasOwn(protocolErrors,reply.error)?reply.error:'event_request_refused';return finish(Error(reason));}finish(null,reply.result);}catch{finish(Error('event_service_invalid'));}
 });
});}

export function makeEventRoute(legacy,call=eventCall){return async request=>{
 const method=request?.method,id=request?.id;
 if(['events/subscribe','events/unsubscribe'].includes(method)){
  if(request.jsonrpc!=='2.0'||!validRequestId(id))return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}};
  if(!request.params||typeof request.params!=='object'||Array.isArray(request.params))return {jsonrpc:'2.0',id,error:{code:-32602,message:'Invalid parameters'}};
  try{return {jsonrpc:'2.0',id,result:await call(method,request.params)};}
  catch(error){const known=Object.hasOwn(protocolErrors,error.message);const [code,message]=known?protocolErrors[error.message]:[-32000,'event_request_unconfirmed'];return {jsonrpc:'2.0',id,error:{code,message,data:{reason:known?error.message:'service_refused_or_unavailable',automatic_retry:false}}};}
 }
 if(method==='tools/call'&&request.params?.name==='events_status'){
  const args=request.params.arguments;
  if(request.jsonrpc!=='2.0'||!validRequestId(id)||!args||Array.isArray(args)||Object.keys(args).length!==1||args.host!=='raspberry')return {jsonrpc:'2.0',id:id??null,result:{isError:true,content:[{type:'text',text:'invalid_parameters'}]}};
  try{const result={...await call('status',{}),frontend_payload_contract:structuredClone(payloadContractMetadata)};return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false}};}
  catch{return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'event_status_unavailable; household health unknown'}]}};}
 }
 // Adapt only event discovery IDs for the legacy route; preserve the caller's opaque ID.
 const discovery=['server/discover','events/list'].includes(method)&&validRequestId(id);
 const result=await legacy(discovery?{...request,id:0}:request);
 if(discovery&&result)result.id=id;
 if(method==='tools/call'&&request.params?.name==='maintenance_capabilities'){
  const augment=value=>{if(value?.evidence?.data?.tool_names){const d=value.evidence.data;if(!d.tool_names.includes('events_status'))d.tool_names.push('events_status');d.listed_tool_count=d.tool_names.length;d.native_events={subscription_requires_approved_worker:true,delivery_requires_verified_callback:true,automatic_retry:false,assistant_run_proven:false};}return value;};
  if(result?.result?.structuredContent)augment(result.result.structuredContent);
  for(const item of result?.result?.content||[])if(item.type==='text'){try{item.text=JSON.stringify(augment(JSON.parse(item.text)));}catch{}}
 }
 if(method==='tools/list'&&result?.result?.tools){
  for(const tool of result.result.tools)if(tool.name==='operation_submit'){
   const operations=tool.inputSchema?.properties?.operation?.enum;
   if(Array.isArray(operations)&&!operations.includes('recover_git_backup_once'))operations.push('recover_git_backup_once');
   tool.description+=' recover_git_backup_once is inert until a separately approved incident/tree plan is armed. Fixed Git-only worker; preserves scanner/hooks; never replays uncertain outcomes.';
  }
  result.result.tools.push(statusDescriptor);
 }
 if(method==='events/list'&&result?.result?.events)for(const event of result.result.events)if(event.name==='smart_home.observation'){event.payloadSchema=eventPayloadSchema;event.description='Sanitized HA persistent-notification changes for /mnt/data/docker. One active subscription, signed HTTPS callback verification, grouped delivery at least ten minutes apart, at most 144 attempts per rolling day. No automatic retry after uncertain delivery. Removal is not proof of recovery. Subscription activation requires the installed approved event service.';}
 return result;
};}

async function serve(){
 const {makeRoute}=await import('./notices-server.mjs');
 const {route:legacy}=await import('./durable-server.mjs');
 const {route:toolRoute,brokerCall}=await import('./expanded-server.mjs');
 const route=makeEventRoute(makeRoute(legacy,toolRoute,brokerCall,row=>fs.writeSync(2,JSON.stringify(row)+'\n')));
 let pending=Buffer.alloc(0),count=0,start=Date.now();
 for await(const chunk of process.stdin){let offset=0;while(offset<chunk.length){
  const end=chunk.indexOf(10,offset),stop=end<0?chunk.length:end+1;
  if(pending.length+stop-offset>16384)return;
  pending=Buffer.concat([pending,chunk.subarray(offset,stop)]);offset=stop;if(end<0)continue;
  if(Date.now()-start>=60000){start=Date.now();count=0;}if(++count>60)return;
  let request;try{request=JSON.parse(pending.toString('utf8'));}catch{request=null;}pending=Buffer.alloc(0);
  const result=await route(request);if(result&&!process.stdout.write(JSON.stringify(result)+'\n'))await new Promise(resolve=>process.stdout.once('drain',resolve));
 }}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)serve().catch(()=>{process.stderr.write('{"error":"events_frontend_failed"}\n');process.exitCode=1;});
