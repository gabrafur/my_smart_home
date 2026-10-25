const id={type:'string',pattern:'^[a-f0-9]{32}$'};
const common={host:{type:'string',enum:['raspberry']},operation_id:id};
const schemas={
 create:{...common,task_key:{type:'string',pattern:'^[a-z][a-z0-9-]{2,63}$'},objective:{type:'string',minLength:1,maxLength:4000},acceptance:{type:'string',minLength:1,maxLength:1500}},
 send:{...common,task_id:id,text:{type:'string',minLength:1,maxLength:6000}},
 status:{...common,kind:{type:'string',enum:['creation','turn']}},
 reconcile:{...common,result_hash:{type:'string',pattern:'^[a-f0-9]{64}$'}},
 revoke:{host:common.host},
};
export const descriptors=Object.entries(schemas).map(([action,properties])=>({
 name:'codex_task_'+action,
 description:({
  create:'Create one scoped task thread with fixed project and permissions. Uses the existing approved expiry; never accepts configuration, paths, commands or privilege overrides. Persist task identity centrally. Response loss is uncertain and is never replayed. Creation does not send the objective.',
  send:'Send bounded task instructions to an adapter-created task only. Shared serial gate with legacy sends; aggregate 48 sends per24h, 60s spacing and included subscription only. Same operation_id never replays uncertain input. Does not extend access or authorize household effects.',
  status:'Observe an adapter creation receipt or the exact recorded Codex turn. notLoaded is not completion. No raw history, tool output or private logs. Observation failure never permits restarting the task.',
  reconcile:'Acknowledge the exact terminal result hash after recording the result in the central checkpoint. Cannot release running or uncertain work. No send or execution.',
  revoke:'Stop new dynamic and legacy adapter sends while preserving receipts and observation. Does not interrupt a running turn, remove subscriptions or alter root policy.',
 })[action],
 inputSchema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)},
 annotations:{readOnlyHint:action==='status',destructiveHint:['create','send','revoke'].includes(action),idempotentHint:true,openWorldHint:false},
}));
descriptors.push({name:'codex_threads_list',
 description:'Read-only listing of the existing authorized threads and adapter registry on Raspberry. Partial host coverage, sanitized metadata, live keyset pagination, newest activity first. No creation, resume, send or permission extension; notLoaded is not completion. Native titles and unvalidated links are withheld.',
 inputSchema:{type:'object',additionalProperties:false,required:['host','limit','cursor'],properties:{host:common.host,limit:{type:'integer',minimum:1,maximum:50},cursor:{type:['string','null'],maxLength:512}}},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}});
