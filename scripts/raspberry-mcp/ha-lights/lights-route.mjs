// Fixed lighting route for the isolated MCP frontend. Only a registered target key
// and on/off travel to the broker; entities, services and credentials stay Root-side.
import net from 'node:net';
const SOCKET='/run/raspberry-mcp/ha-lights.sock';
const TARGETS=['lampadas_garagem','lampada_varanda','abajour_sala_de_estar','refletores_jardim','refletor_portao_carros'];
export const lightDescriptors=[
 {name:'ha_lights_read',description:'Read the current on/off state of the registered household lights (garage, porch, living-room lamp, garden floodlights, car-gate floodlight). Omit target to list all. Read only.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},target:{anyOf:[{type:'string',enum:TARGETS},{type:'null'}]}},required:['host']},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'ha_light_set',description:'Turn one registered household light on or off through Home Assistant, then read its real state back. state=confirmed means Home Assistant reports the requested state. Never resend after uncertain/unconfirmed; observe with ha_lights_read. Use ha_action_run for the air conditioner, PC shutdown and garage gate; alarm, locks and other devices are not reachable.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},target:{type:'string',enum:TARGETS},state:{type:'string',enum:['on','off']}},required:['host','target','state']},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
];
const ACTIONS={ar_condicionado_escritorio:['on','off'],pc_gabriel:['poweroff'],portao_garagem:['pulse']};
export const actionDescriptors=[
 {name:'ha_actions_read',description:'Read the registered household actions and whether each can run now: office air conditioner (on/off state), PC shutdown and garage gate pulse. Omit target to list all. Read only.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},target:{anyOf:[{type:'string',enum:Object.keys(ACTIONS)},{type:'null'}]}},required:['host']},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'ha_action_run',description:'Run one registered household action through Home Assistant. ar_condicionado_escritorio: action on or off (state read back). pc_gabriel: action poweroff shuts the owner PC down (not read back). portao_garagem: action pulse sends ONE pulse to the garage gate button, which runs the next step of the gate cycle (open, stop or close); the gate has no position sensor, so only call it when the owner asked to open or close the gate, and never repeat it after uncertain/unconfirmed: observe with ha_actions_read. Rate limited per action.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},target:{type:'string',enum:Object.keys(ACTIONS)},action:{type:'string',enum:['on','off','poweroff','pulse']}},required:['host','target','action']},
  annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},
];
const DOMAINS=['light','switch','fan','climate','media_player','cover','vacuum','remote','button','scene','script','input_boolean','input_button','number','select','lock','alarm_control_panel'];
export const houseDescriptors=[
 {name:'ha_entities_read',description:'List the household entities Eva may control (lights, switches, fans, air conditioners, TVs and other media players, covers, vacuum, remotes, buttons, scenes, scripts, locks, alarm panels) with their current state and the services each accepts. Filter by domain and/or a search text on the id or name (max 100 rows). Read only. Use it to find the entity_id before ha_service_call.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},domain:{anyOf:[{type:'string',enum:DOMAINS},{type:'null'}]},search:{anyOf:[{type:'string',minLength:1,maxLength:64},{type:'null'}]}},required:['host']},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'ha_service_call',description:'Call one Home Assistant service on one household entity found with ha_entities_read, for example light.turn_on, climate.set_temperature, media_player.turn_off or media_player.volume_set, cover.open_cover, lock.lock. Optional data holds only plain service fields (brightness_pct, temperature, hvac_mode, volume_level, source, ...). Never resent automatically: after uncertain/unconfirmed, observe with ha_entities_read. The garage gate is opened only through ha_action_run (portao_garagem); the Raspberry power controls and the gate relay are denied.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},domain:{type:'string',enum:DOMAINS},service:{type:'string',pattern:'^[a-z_]{1,48}$'},entity_id:{type:'string',pattern:'^[a-z_]{1,32}\\.[a-z0-9_]{1,96}$'},data:{type:'object',additionalProperties:{anyOf:[{type:'string',maxLength:512},{type:'number'},{type:'boolean'},{type:'array',maxItems:4,items:{type:'number'}}]},maxProperties:8}},required:['host','domain','service','entity_id']},
  annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},
];
const names=new Set([...lightDescriptors,...actionDescriptors,...houseDescriptors].map(d=>d.name));
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export function validLightArgs(name,a){
 if(!plain(a)||a.host!=='raspberry')return false;
 if(name==='ha_entities_read')return Object.keys(a).every(k=>['host','domain','search'].includes(k))&&(a.domain==null||DOMAINS.includes(a.domain))&&(a.search==null||(typeof a.search==='string'&&a.search.length>0&&a.search.length<=64));
 if(name==='ha_service_call')return Object.keys(a).every(k=>['host','domain','service','entity_id','data'].includes(k))&&DOMAINS.includes(a.domain)&&typeof a.service==='string'&&/^[a-z_]{1,48}$/.test(a.service)&&typeof a.entity_id==='string'&&/^[a-z_]{1,32}\.[a-z0-9_]{1,96}$/.test(a.entity_id)&&a.entity_id.split('.')[0]===a.domain&&(a.data===undefined||(plain(a.data)&&Object.keys(a.data).length<=8&&Object.values(a.data).every(v=>['string','number','boolean'].includes(typeof v)||(Array.isArray(v)&&v.length<=4&&v.every(x=>typeof x==='number')))));
 if(name==='ha_actions_read')return Object.keys(a).every(k=>['host','target'].includes(k))&&(a.target===undefined||a.target===null||Object.hasOwn(ACTIONS,a.target));
 if(name==='ha_action_run')return Object.keys(a).length===3&&Object.hasOwn(ACTIONS,a.target)&&ACTIONS[a.target].includes(a.action);
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
// The sealed diagnostics broker lists "no_actuators" for its own diagnostic scope.
// Add, never rewrite, an explicit statement of the separate lighting tools.
export const householdLights={tools:['ha_lights_read','ha_light_set','ha_actions_read','ha_action_run','ha_entities_read','ha_service_call'],targets:TARGETS,
 actions:ACTIONS,scope:'whole_household_devices',not_reachable:['raspberry_power','gate_relay','system_administration'],
 note:'no_actuators refers to the diagnostic and maintenance tools; household devices are found with ha_entities_read and driven with ha_service_call, the gate pulse, PC shutdown and air conditioner also by ha_action_run, each limited by the broker.'};
export function annotateCapabilities(response){
 const r=response?.result;
 if(!r||!plain(r.structuredContent))return response;
 r.structuredContent.household_lights=structuredClone(householdLights);
 const t=Array.isArray(r.content)?r.content.find(x=>x?.type==='text'):undefined;
 if(t){try{const v=JSON.parse(t.text);if(plain(v)){v.household_lights=structuredClone(householdLights);t.text=JSON.stringify(v);}}catch{}}
 return response;
}
export function makeLightsRoute(prior,invoke=invokeLights,audit=()=>{}){
 return async(q,...rest)=>{
  if(q?.method==='tools/call'&&names.has(q.params?.name)){
   const name=q.params.name,a=q.params.arguments;
   if(!validLightArgs(name,a))return{jsonrpc:'2.0',id:q.id??null,error:{code:-32602,message:'registered_light_parameters_refused'}};
   let value;
   try{
    const args=name==='ha_entities_read'?{host:'raspberry',...(a.domain?{domain:a.domain}:{}),...(a.search?{search:a.search}:{})}
     :name==='ha_service_call'?{host:'raspberry',domain:a.domain,service:a.service,entity_id:a.entity_id,...(a.data?{data:a.data}:{})}
     :name==='ha_lights_read'||name==='ha_actions_read'?{host:'raspberry',...(a.target?{target:a.target}:{})}
     :name==='ha_action_run'?{host:'raspberry',target:a.target,action:a.action}:{host:'raspberry',target:a.target,state:a.state};
    value=await invoke({name,arguments:args});
    if(!plain(value))throw Error();
   }catch{value={state:'unknown',source:'fixed_home_assistant_lighting_broker',collection_error:'lights_route_unavailable',automatic_retry:false};}
   const isError=!!value.collection_error||['refused','unknown'].includes(value.state);
   try{audit({tool:name,id:q.id,success:!isError,state:typeof value.state==='string'?value.state.slice(0,32):'unknown'});}catch{}
   return{jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError}};
  }
  const response=await prior(q,...rest);
  if(q?.method==='tools/list'&&Array.isArray(response?.result?.tools))
   for(const d of [...lightDescriptors,...actionDescriptors,...houseDescriptors])if(!response.result.tools.some(t=>t.name===d.name))response.result.tools.push(structuredClone(d));
  if(q?.method==='tools/call'&&q.params?.name==='maintenance_capabilities')annotateCapabilities(response);
  return response;
 };
}
