// Proposed tools only. This module is not installed or registered in production.
const host={type:'string',enum:['raspberry']},id={type:'string',pattern:'^[a-f0-9]{32}$'},sha={type:'string',pattern:'^[a-f0-9]{64}$'};
const component={type:'string',enum:['localizacao_pessoas','observacao_host','external_heartbeat','icloud_adapter']};
const common={host,operation_id:id};
const definitions=[
 ['component_list',{host},['host'],true],
 ['component_read',{host,component_id:component,view:{type:'string',enum:['catalog','topology','parameters','source','version']},artifact_id:id,offset:{type:'integer',minimum:0,maximum:1048576},expected_digest:sha},['host','component_id','view'],true],
 ['component_prepare_repair',{...common,task_id:id,component_id:component,artifact_id:id,expected_source_sha256:sha,old_text:{type:'string',minLength:1,maxLength:4000},new_text:{type:'string',maxLength:4000}},['host','operation_id','task_id','component_id','artifact_id','expected_source_sha256','old_text','new_text'],false],
 ['component_validate_repair',common,Object.keys(common),false],
 ['component_apply_repair',{...common,expected_loaded_sha256:sha},['host','operation_id','expected_loaded_sha256'],false],
 ['component_repair_status',common,Object.keys(common),true],
 ['component_repair_reconcile',common,Object.keys(common),false],
 ['component_verify_repair',common,Object.keys(common),false],
 ['component_revert_repair',{...common,expected_loaded_sha256:sha},['host','operation_id','expected_loaded_sha256'],false],
 ['component_scope_release',{...common,result_hash:sha},['host','operation_id','result_hash'],false],
 ['component_cancel_repair',common,Object.keys(common),false],
 ['task_scope_list',{host,page_size:{type:'integer',minimum:1,maximum:16},cursor:{type:['string','null'],maxLength:512}},['host'],true],
];
export const descriptors=definitions.map(([name,properties,required,read])=>({name,description:'CANDIDATE: scoped Raspberry component workflow; not installed. No free paths, commands, privileges, callbacks or private history. Uncertain effects are never replayed.',inputSchema:{type:'object',additionalProperties:false,properties,required},annotations:{readOnlyHint:read,destructiveHint:['component_apply_repair','component_revert_repair'].includes(name),idempotentHint:true,openWorldHint:false}}));
function field(value,schema){
 if(Array.isArray(schema.type)){if(value===null)return schema.type.includes('null');schema={...schema,type:schema.type.find(x=>x!=='null')};}
 if(schema.type==='string')return typeof value==='string'&&(!schema.enum||schema.enum.includes(value))&&(!schema.pattern||new RegExp(schema.pattern).test(value))&&(schema.minLength===undefined||value.length>=schema.minLength)&&(schema.maxLength===undefined||value.length<=schema.maxLength);
 if(schema.type==='integer')return Number.isInteger(value)&&value>=schema.minimum&&value<=schema.maximum;
 return false;
}
export function validate(name,args){const d=descriptors.find(x=>x.name===name);if(!d||!args||typeof args!=='object'||Array.isArray(args))return false;const s=d.inputSchema;return s.required.every(k=>Object.hasOwn(args,k))&&Object.keys(args).every(k=>Object.hasOwn(s.properties,k)&&field(args[k],s.properties[k]));}
export function makeCandidateRoute(prior,authenticatedDispatch,invoke,audit=()=>{}){return async request=>{
 const name=request?.params?.name;
 if(request?.method==='tools/call'&&descriptors.some(x=>x.name===name)){
  if(!validate(name,request.params.arguments))return {jsonrpc:'2.0',id:request.id??null,result:{isError:true,content:[{type:'text',text:'invalid_parameters'}]}};
  return authenticatedDispatch({...request,params:{...request.params,name:'project_files'}},undefined,row=>audit({...row,tool:name}),()=>invoke({name,arguments:request.params.arguments}));
 }
 const result=await prior(request);if(request?.method==='tools/list'&&result?.result?.tools)result.result.tools.push(...structuredClone(descriptors));return result;
};}
