// Fixed read-only Home Assistant state route for the isolated MCP frontend. Only a
// registered entity id (or none, for all) travels to the broker; the broker reads
// state over REST and never calls a service. Entities and credentials stay Root-side.
import net from 'node:net';
const SOCKET='/run/raspberry-mcp/ha-states.sock';
const ENTITIES=["binary_sensor.internet_connection", "binary_sensor.tuya_devices", "binary_sensor.vpn_primary_connection", "binary_sensor.zigbee_network", "input_boolean.nodered_runtime_incident", "sensor.backup_last_successful_automatic_backup", "sensor.backup_next_scheduled_automatic_backup", "sensor.backup_result_git", "sensor.backup_result_offsite", "sensor.backup_result_restore", "sensor.botao_portao_garagem_battery", "sensor.controlador_ir_battery", "sensor.lds_robot_battery", "sensor.raspberry_pi_cpu_temperature", "sensor.raspberry_pi_health", "sensor.raspberry_pi_load_5m", "sensor.raspberry_pi_memory_usage", "sensor.raspberry_pi_storage_usage", "sensor.raspberry_pi_uptime", "update.alexa_media_player_update", "update.kia_uvo_hyundai_bluelink_update", "update.moni_mobile_alarm_update", "update.slzb_mrw10u_zigbee_firmware"];
export const statesDescriptors=[
 {name:'ha_states_read',description:'Read the live Home Assistant state of the registered status entities (Raspberry health, load, memory, disk, temperature; internet, VPN, Zigbee and Tuya; Node-RED incident; Git/offsite/restore backup results; HA backups; pending updates; device batteries). Each row has value, unit, measured_at (last report), age_seconds and available. Omit entity_id to list all. Read only: no service is called; alarm, locks, gate and location are not reachable.',
  inputSchema:{type:'object',additionalProperties:false,properties:{host:{type:'string',enum:['raspberry']},entity_id:{anyOf:[{type:'string',enum:ENTITIES},{type:'null'}]}},required:['host']},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
];
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export function validStatesArgs(a){
 return plain(a)&&a.host==='raspberry'&&Object.keys(a).every(k=>['host','entity_id'].includes(k))
  &&(a.entity_id===undefined||a.entity_id===null||ENTITIES.includes(a.entity_id));
}
export function invokeStates(request,socket=SOCKET){return new Promise((resolve,reject)=>{
 const raw=JSON.stringify(request)+'\n';let out=Buffer.alloc(0),done=false;
 const c=net.createConnection({path:socket}),timer=setTimeout(()=>finish(Error('states_transport_deadline')),20000);
 function finish(error,value){if(done)return;done=true;clearTimeout(timer);c.destroy();error?reject(error):resolve(value)}
 c.once('connect',()=>c.end(raw));c.on('error',()=>finish(Error('states_transport_unconfirmed')));
 c.on('data',b=>{if(out.length+b.length>131072)return finish(Error('states_response_limit'));out=Buffer.concat([out,b]);});
 c.on('end',()=>{try{if(out.at(-1)!==10)throw Error();finish(null,JSON.parse(out.toString('utf8')))}catch{finish(Error('states_response_unconfirmed'))}});
});}
export function makeStatesRoute(prior,invoke=invokeStates,audit=()=>{}){
 return async(q,...rest)=>{
  if(q?.method==='tools/call'&&q.params?.name==='ha_states_read'){
   const a=q.params.arguments;
   if(!validStatesArgs(a))return{jsonrpc:'2.0',id:q.id??null,error:{code:-32602,message:'registered_entity_parameters_refused'}};
   let value;
   try{
    value=await invoke({name:'ha_states_read',arguments:{host:'raspberry',...(a.entity_id?{entity_id:a.entity_id}:{})}});
    if(!plain(value))throw Error();
   }catch{value={state:'unknown',source:'fixed_home_assistant_state_broker',collection_error:'states_route_unavailable',automatic_retry:false};}
   const isError=['refused','unknown'].includes(value.state);
   try{audit({tool:'ha_states_read',id:q.id,success:!isError,state:typeof value.state==='string'?value.state.slice(0,32):'unknown'});}catch{}
   return{jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError}};
  }
  const response=await prior(q,...rest);
  if(q?.method==='tools/list'&&Array.isArray(response?.result?.tools))
   for(const d of statesDescriptors)if(!response.result.tools.some(t=>t.name===d.name))response.result.tools.push(structuredClone(d));
  return response;
 };
}
