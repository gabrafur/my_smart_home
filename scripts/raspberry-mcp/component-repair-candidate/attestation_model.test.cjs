const test=require('node:test'),assert=require('node:assert/strict');
const {artifactSet,normalizedIdentity,project}=require('./attestation_model.cjs');
const component='observacao_host';
const reviewedFor=flow=>{const raw=artifactSet(component,flow);const {nodes,...tab}=flow;return {source_sha256:raw.sha256,artifacts:raw.artifacts,runtime_comparison:{kind:'nodered_scoped_configuration_v1',sha256:normalizedIdentity([{...tab,type:'tab'},...nodes])}};};
const fixture=()=>({id:'host_observer_tab',label:'source',disabled:false,info:'',env:[],nodes:[{id:'fn',type:'function',z:'host_observer_tab',name:'reviewed',func:'return msg;',outputs:1,wires:[['outside']]}]});
test('matched deployed configuration uses the reviewed artifact identity domain',()=>{
 const flow=fixture(),actual=artifactSet(component,flow),reviewed=reviewedFor(flow);
 const out=project(component,flow,reviewed,'2026-10-25T20:00:00Z');
 assert.equal(out.state,'observed');assert.equal(out.loaded_sha256,reviewed.runtime_comparison.sha256);assert.equal(out.root_verified,false);
 assert.equal(out.loaded_identity_kind,'nodered_scoped_configuration_v1');assert.doesNotMatch(JSON.stringify(out),/return msg/);
});
test('changed loaded source or private config never exports its hash or contents',()=>{
 const flow=fixture(),actual=artifactSet(component,flow),reviewed=reviewedFor(flow);
 for(const mutation of [x=>{x.nodes[0].func='PRIVACY_TEST_FIXTURE';},x=>{x.env=[{name:'password',value:'PRIVACY_TEST_FIXTURE'}];},x=>{x.nodes[0].property='PRIVACY_TEST_FIXTURE';}]) {
  const changed=structuredClone(flow);mutation(changed);const out=project(component,changed,reviewed,'2026-10-25T20:00:00Z');
  assert.equal(out.state,'unknown');assert.equal(out.loaded_sha256,null);assert.doesNotMatch(JSON.stringify(out),/PRIVACY_TEST_FIXTURE/);
 }
});
test('wrong scope, duplicate nodes and unexpected response fields remain unknown',()=>{
 const source=fixture(),set=artifactSet(component,source),reviewed=reviewedFor(source);
 for(const input of [{...source,id:'other'},{...source,nodes:[...source.nodes,...source.nodes]},{...source,password:'PRIVACY_TEST_FIXTURE'}]) {
  const out=project(component,input,reviewed,'2026-10-25T20:00:00Z');assert.equal(out.state,'unknown');assert.equal(out.loaded_sha256,null);
 }
});

test('only empty trailing port arrays normalize; connected port index and outputs remain strict',()=>{
 const flow=fixture();flow.nodes[0].wires=[[],['outside']];flow.nodes[0].outputs=2;const reviewed=reviewedFor(flow);
 const same=structuredClone(flow);same.nodes[0].wires.push([]);
 assert.equal(project(component,same,reviewed,'2026-10-25T20:00:00Z').state,'observed');
 for(const change of [x=>{x.nodes[0].wires=[['outside']];},x=>{x.nodes[0].wires.push(['new']);},x=>{x.nodes[0].outputs=3;}]) {
  const altered=structuredClone(flow);change(altered);assert.equal(project(component,altered,reviewed,'2026-10-25T20:00:00Z').state,'unknown');
 }
});

test('missing wires and empty disconnected port arrays are the same configuration',()=>{
 const flow=fixture();flow.nodes[0].wires=[];const reviewed=reviewedFor(flow);
 const missing=structuredClone(flow);delete missing.nodes[0].wires;
 assert.equal(project(component,missing,reviewed,'2026-10-25T20:00:00Z').state,'observed');
 const connected=structuredClone(missing);connected.nodes[0].wires=[['outside']];
 assert.equal(project(component,connected,reviewed,'2026-10-25T20:00:00Z').state,'unknown');
});
