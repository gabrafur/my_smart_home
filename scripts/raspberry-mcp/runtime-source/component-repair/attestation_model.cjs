// Candidate only: computes identities without exporting unreviewed runtime content.
const crypto = require('node:crypto');
const IDS = Object.freeze({localizacao_pessoas:'ea0a6aa0d24ff863',observacao_host:'host_observer_tab'});
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;
const bytes = value => Buffer.from(JSON.stringify(stable(value))+'\n','utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = reason => {throw new Error(reason);};
function artifactSet(component, flow) {
 if(!Object.hasOwn(IDS,component)||!flow||flow.id!==IDS[component]||!Array.isArray(flow.nodes)||flow.nodes.length>2048)fail('scoped_flow_invalid');
 if(Object.keys(flow).some(key=>!['id','label','disabled','info','env','nodes'].includes(key)))fail('scoped_flow_shape_changed');
 const tab=Object.fromEntries(['id','label','disabled','info','env'].filter(key=>Object.hasOwn(flow,key)).map(key=>[key,flow[key]]));tab.type='tab';
 const nodes=[tab,...flow.nodes].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const selected=new Set();
 for(const node of nodes){if(!node||typeof node.id!=='string'||selected.has(node.id)||(node.id!==tab.id&&node.z!==tab.id))fail('scoped_node_identity_invalid');selected.add(node.id);}
 const edges=[];
 for(const node of nodes)for(const port of node.wires??[])for(const target of port)edges.push({from:node.id,to:target,external:!selected.has(target)});
 for(const node of nodes)for(const target of node.links??[])edges.push({from:node.id,to:target,external:!selected.has(target),kind:'link'});
 const pick=(node,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(node,key)).map(key=>[key,node[key]]));
 const topology={source:'reviewed_public_NodeRED_flow',nodes:nodes.map(node=>pick(node,['id','type','name','label'])),edges};
 const parameters=nodes.map(node=>pick(node,['id','type','name','property','propertyType','rules','checkall','outputs','timeout']));
 const artifacts={};
 for(const [kind,label,data]of [['source','scoped_flow_source',bytes(nodes)],['topology','scoped_graph',bytes(topology)],['parameters','public_parameters',bytes(parameters)]]) {
  if(data.length>1048576)fail('scoped_artifact_limit');
  artifacts[sha(Buffer.from(component+':'+label)).slice(0,32)]={kind,sha256:sha(data),size_bytes:data.length,logical_source:label};
 }
 return {artifacts,sha256:sha(bytes(artifacts))};
}
function normalizedIdentity(nodes) {
 const normalized=nodes.map(node=>{
  const copy=structuredClone(node);
  if(!Object.hasOwn(copy,'wires'))copy.wires=[];
  if(Object.hasOwn(copy,'wires')) {
   if(!Array.isArray(copy.wires)||copy.wires.some(port=>!Array.isArray(port)))fail('invalid_wire_ports');
   while(copy.wires.length&&copy.wires.at(-1).length===0)copy.wires.pop();
  }
  return copy;
 }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 return sha(bytes(normalized));
}
function scopedNodes(component,flow) {
 artifactSet(component,flow); // Validate scope and bounds first.
 const tab=Object.fromEntries(['id','label','disabled','info','env'].filter(key=>Object.hasOwn(flow,key)).map(key=>[key,flow[key]]));tab.type='tab';
 return [tab,...flow.nodes];
}
function project(component,flow,reviewed,observedAt) {
 const out={source:'protected_loaded_component_attestation',component_id:component,root_verified:false,
  state:'unknown',observed_at:observedAt,loaded_sha256:null,loaded_identity_kind:'nodered_scoped_configuration_v1',
  collection_error:'loaded_scope_not_reviewed',coverage:['deployed_NodeRED_normalized_configuration_not_node_execution','no_unreviewed_source_or_configuration_export','not_functional_recovery_proof']};
 try {
  const actual=artifactSet(component,flow);
  const identity=normalizedIdentity(scopedNodes(component,flow));
  const expected=reviewed?.runtime_comparison;
  if(expected?.kind!=='nodered_scoped_configuration_v1'||identity!==expected.sha256)return {...out,reviewed_artifact_matches:Object.fromEntries(Object.entries(actual.artifacts).map(([id,item])=>[item.kind,JSON.stringify(stable(item))===JSON.stringify(stable(reviewed?.artifacts?.[id]))]))};
  return {...out,state:'observed',collection_error:null,loaded_sha256:identity,
   normalizations:['missing_wires_are_empty','remove_empty_trailing_wire_port_arrays_only']};
 }catch{return {...out,collection_error:'scoped_runtime_collection_invalid'};}
}
module.exports={IDS,artifactSet,normalizedIdentity,project};
