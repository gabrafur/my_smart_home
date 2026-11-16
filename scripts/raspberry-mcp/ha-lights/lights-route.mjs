// Fixed lighting route for the isolated MCP frontend. Only a registered target key
// and on/off travel to the broker; entities, services and credentials stay Root-side.
import net from 'node:net';
const SOCKET='/run/raspberry-mcp/ha-lights.sock';
const TARGETS=['lampadas_garagem','lampada_varanda','abajour_sala_de_estar','refletores_jardim','refletor_portao_carros'];
export const lightDescriptors=[
 {name:'ha_lights_read',description:'Read the current on/off state of the registered household lights (garage, porch, living-room lamp, garden floodlights, car-gate floodlight). Omit target to list all. Read only.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},target:{anyOf:[{type:'string',enum:TARGETS},{type:'null'}]}},required:['host']},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'ha_light_set',description:'Turn one registered household light on or off through Home Assistant, then read its real state back. state=confirmed means Home Assistant reports the requested state. Never resend after uncertain/unconfirmed; observe with ha_lights_read. Gates, alarm, locks and other devices are not reachable.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},target:{type:'string',enum:TARGETS},state:{type:'string',enum:['on','off']}},required:['host','target','state']},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
];
const names=new Set(lightDescriptors.map(d=>d.name));
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export function validLightArgs(name,a){
 if(!plain(a)||a.host!=='raspberry')return false;
 if(name==='ha_lights_read')return Object.keys(a).every(k=>['host','target'].includes(k))&&(a.target===undefined||a.target===null||TARGETS.includes(a.target));
 return Object.keys(a).length===3&&TARGETS.includes(a.target)&&['on','off'].includes(a.state);
}
export function invokeLights(request,socket=SOCKET){return new Promise((resolve,reject)=>{
 const raw=JSON.stringify(request)+'\n';let out=Buffer.alloc(0),done=false;
 const c=net.createConnection({path:socket}),timer=setTimeout(()=>finish(Error('lights_transport_deadline')),20000);
 function finish(error,value){if(done)return;done=true;clearTimeout(timer);c.destroy();error?reject(error):resolve(value)}
 c.once('connect',()=>c.end(raw));c.on('error',()=>finish(Error('lights_transport_unconfirmed')));
 c.on('data',b=>{if(out.length+b.length>32768)return finish(Error('lights_response_limit'));out=Buffer.concat([out,b]);});
 c.on('end',()=>{try{if(out.at(-1)!==10)throw Error();finish(null,JSON.parse(out.toString('utf8')))}catch{finish(Error('lights_response_unconfirmed'))}});
});}
export function makeLightsRoute(prior,invoke=invokeLights,audit=()=>{}){
 return async(q,...rest)=>{
  if(q?.method==='tools/call'&&names.has(q.params?.name)){
   const name=q.params.name,a=q.params.arguments;
   if(!validLightArgs(name,a))return{jsonrpc:'2.0',id:q.id??null,error:{code:-32602,message:'registered_light_parameters_refused'}};
   let value;
   try{
    const args=name==='ha_lights_read'?{host:'raspberry',...(a.target?{target:a.target}:{})}:{host:'raspberry',target:a.target,state:a.state};
    value=await invoke({name,arguments:args});
    if(!plain(value))throw Error();
   }catch{value={state:'unknown',source:'fixed_home_assistant_lighting_broker',collection_error:'lights_route_unavailable',automatic_retry:false};}
   audit({tool:name,id:q.id,state:typeof value.state==='string'?value.state.slice(0,32):'unknown'});
   return{jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,
    isError:!!value.collection_error||['refused','unknown'].includes(value.state)}};
  }
  const response=await prior(q,...rest);
  if(q?.method==='tools/list'&&Array.isArray(response?.result?.tools))
   for(const d of lightDescriptors)if(!response.result.tools.some(t=>t.name===d.name))response.result.tools.push(structuredClone(d));
  return response;
 };
}
