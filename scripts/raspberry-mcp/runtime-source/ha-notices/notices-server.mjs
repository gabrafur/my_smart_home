import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const descriptor={name:'ha_notifications',description:'Read a bounded sanitized snapshot of HA persistent notifications. Provides reviewed sanitized title/message and bounded associated exceptions; raw content and private history remain withheld. Source failure, old data and missing data remain distinct. Removal is not proof of recovery. No HA calls, dismissals, mobile messages or execution. Reuse digest when requesting later pages.',
 inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},offset:{type:'integer',minimum:0,maximum:512},expected_digest:{type:'string',pattern:'^[a-f0-9]{64}$'},notification_id:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['host']},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
// Discovery-only gate permits testing account visibility without accepting a
// subscription, persisting its signing key, contacting its callback or starting AI.
export const eventDescriptor={name:'smart_home.observation',description:'Sanitized HA persistent-notification changes for /mnt/data/docker. Discovery is available for account compatibility testing; subscription activation remains administratively blocked.',delivery:['webhook'],
 inputSchema:{type:'object',additionalProperties:false,properties:{project:{type:'string',enum:['/mnt/data/docker']},topics:{type:'array',items:{type:'string',enum:['ha_notification']},minItems:1,maxItems:1,uniqueItems:true}},required:['project','topics']},
 payloadSchema:{type:'object',additionalProperties:false,properties:{project:{type:'string',enum:['/mnt/data/docker']},topic:{type:'string',enum:['ha_notification']},source:{type:'string',enum:['ha_persistent_notification']},phase:{type:'string',enum:['added','updated','removed']},object_id:{type:'string',pattern:'^[a-f0-9]{64}$'},revision:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['project','topic','source','phase','object_id','revision']}};

export function makeRoute(legacyRoute,legacyToolRoute,brokerCall,audit=()=>{}){
 return async function route(request,read,invoke=brokerCall){
  if(['server/discover','events/list','events/subscribe','events/unsubscribe'].includes(request?.method)){
   const id=request?.id;
   if(request.jsonrpc!=='2.0'||!(typeof id==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(id)||Number.isSafeInteger(id)))return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}};
   if(request.params!==undefined&&(!request.params||typeof request.params!=='object'||Array.isArray(request.params)))return {jsonrpc:'2.0',id,error:{code:-32602,message:'Invalid parameters'}};
   audit({method:request.method,discovery_only:true});
   if(request.method==='server/discover')return {jsonrpc:'2.0',id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}}}};
   if(request.method==='events/list')return request.params?.cursor?{jsonrpc:'2.0',id,error:{code:-32602,message:'Invalid cursor'}}:{jsonrpc:'2.0',id,result:{events:[eventDescriptor]}};
   return {jsonrpc:'2.0',id,error:{code:-32000,message:'subscription_activation_not_approved',data:{automatic_retry:false}}};
  }
  if(request?.method==='tools/call'&&request.params?.name==='ha_notifications'){
   const args=request.params.arguments;
   if(!args||args.host!=='raspberry'||Object.keys(args).some(k=>!['host','offset','expected_digest','notification_id'].includes(k))||
      (args.offset!==undefined&&(!Number.isInteger(args.offset)||args.offset<0||args.offset>512))||
      (args.expected_digest!==undefined&&(typeof args.expected_digest!=='string'||!/^[a-f0-9]{64}$/.test(args.expected_digest)))||
      (args.notification_id!==undefined&&(typeof args.notification_id!=='string'||!/^[a-f0-9]{64}$/.test(args.notification_id)||args.offset>0)))
    return {jsonrpc:'2.0',id:request.id??null,result:{isError:true,content:[{type:'text',text:'invalid_parameters'}]}};
   const alias={...request,params:{...request.params,name:'project_files'}};
   return legacyToolRoute(alias,read,row=>audit({...row,tool:'ha_notifications'}),()=>invoke(request.params));
  }
  const result=await legacyRoute(request,read,audit,invoke);
  if(request?.method==='tools/list'&&result?.result?.tools)result.result.tools.push(descriptor);
  return result;
 };
}

async function serve(){
 const {route:legacy}=await import('./durable-server.mjs');
 const {route:toolRoute,brokerCall}=await import('./expanded-server.mjs');
 const route=makeRoute(legacy,toolRoute,brokerCall,row=>fs.writeSync(2,JSON.stringify(row)+'\n'));
 let pending=Buffer.alloc(0),count=0,start=Date.now();
 for await(const chunk of process.stdin){let offset=0;while(offset<chunk.length){
  const end=chunk.indexOf(10,offset),stop=end<0?chunk.length:end+1;
  if(pending.length+stop-offset>16384)return;
  pending=Buffer.concat([pending,chunk.subarray(offset,stop)]);offset=stop;if(end<0)continue;
  if(Date.now()-start>=60000){start=Date.now();count=0;}if(++count>60)return;
  let request;try{request=JSON.parse(pending.toString('utf8'))}catch{request=null;}pending=Buffer.alloc(0);
  const result=await route(request);if(result&&!process.stdout.write(JSON.stringify(result)+'\n'))await new Promise(resolve=>process.stdout.once('drain',resolve));
 }}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)serve().catch(()=>{process.stderr.write('{"error":"frontend_failed"}\n');process.exitCode=1;});
