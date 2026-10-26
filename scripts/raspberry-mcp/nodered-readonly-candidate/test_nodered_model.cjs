'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {inventory, nodeRead} = require('./nodered_model.cjs');
const ctx = {observed_at:'2026-10-26T16:00:00.000Z',now:'2026-10-26T16:00:02.500Z',runtime_version:'4.1.1',public_head:'a'.repeat(40)};
function data() { return [{id:'flow-b',type:'tab',label:'Reviewed flow B'}, {id:'flow-a',type:'tab',label:'Reviewed flow A'}, {id:'node-b',type:'debug',z:'flow-a',name:'Reviewed debug',wires:[]}, {id:'node-a',type:'function',z:'flow-a',name:'Reviewed function',func:'return msg;',outputs:1,wires:[['node-b','missing']]}, {id:'config-a',type:'server',name:'Reviewed server'}]; }
const inv = extra => ({host:'raspberry',kind:'nodes',flow_id:null,page_size:2,cursor:null,...extra});
const read = extra => ({host:'raspberry',node_id:'node-a',view:'source',offset:0,limit:4096,...extra});
const refuses = fn => assert.throws(fn, e => e.message === 'nodered_request_refused');
function frozen(value) { if(value&&typeof value==='object') { Object.freeze(value); for(const child of Object.values(value)) frozen(child); } return value; }
test('all flow containers sorted by opaque ID, safe runtime titles, no execution claim', () => {
  const r=data(); const out=inventory(r,r,inv({kind:'flows',page_size:16}),ctx);
  assert.deepEqual(out.items.map(x=>x.id),['flow-a','flow-b']); assert.equal(out.items[0].title,'Reviewed flow A');
  assert.equal(out.age_seconds,2.5); assert.equal(out.collection_error,null); assert.equal(out.functional_recovery_proven,false); assert.ok(out.coverage.includes('not_execution_readiness_or_functional_success'));
});
test('nodes paginate in stable ID order, including configuration nodes', () => {
  const r=data(); const one=inventory(r,r,inv(),ctx); const two=inventory(r,r,inv({cursor:one.pagination.next_cursor}),ctx);
  assert.deepEqual(one.items.map(x=>x.id),['config-a','node-a']); assert.deepEqual(two.items.map(x=>x.id),['node-b']); assert.equal(two.pagination.next_cursor,null);
});
test('flow filter reflects actual membership and validates connections', () => {
  const r=data();const out=inventory(r,r,inv({flow_id:'flow-a',page_size:16}),ctx);
  assert.deepEqual(out.items.map(x=>x.id),['node-a','node-b']); assert.deepEqual(out.items[0].connections,[{output:0,node_id:'node-b'}]);
});
test('cursor bound to runtime snapshot, reviewed evidence, selector and page size', () => {
  const r=data(); const cursor=inventory(r,r,inv(),ctx).pagination.next_cursor;
  const changed=structuredClone(r);changed[3].func='PRIVATE_RUNTIME_SOURCE';
  refuses(()=>inventory(changed,r,inv({cursor}),ctx)); refuses(()=>inventory(r,changed,inv({cursor}),ctx));
  refuses(()=>inventory(r,r,inv({cursor,page_size:1}),ctx)); refuses(()=>inventory(r,r,inv({cursor,flow_id:'flow-a'}),ctx));
  refuses(()=>inventory(r,r,inv({cursor}),{...ctx,observed_at:'2026-10-26T16:00:01.000Z'}));
});
test('malformed and forged out-of-range cursor cannot echo attacker text', () => {
  const r=data();for(const cursor of ['PRIVATE_SECRET','file:///etc/passwd','!!',Buffer.from('{"private":"SECRET"}').toString('base64url')]) refuses(()=>inventory(r,r,inv({cursor}),ctx));
});
test('closed selectors reject extra path/url/command/entity and invalid IDs', () => {
  const r=data();for(const field of ['path','url','command','entity_id']) {refuses(()=>inventory(r,r,{...inv(),[field]:'PRIVATE'},ctx));refuses(()=>nodeRead(r,r,{...read(),[field]:'PRIVATE'},ctx));}
  for(const node_id of ['/etc/passwd','https://private.invalid','missing','__proto__']) refuses(()=>nodeRead(r,r,read({node_id}),ctx));
  refuses(()=>inventory(r,r,inv({host:'other'}),ctx));refuses(()=>inventory(r,r,inv({flow_id:'node-a'}),ctx));
  refuses(()=>nodeRead(r,r,read({node_id:'flow-a'}),ctx));
});
test('unreviewed runtime title and code are withheld, drift and hashes remain', () => {
  const reviewed=data(),r=data();r[3].name='PRIVATE_TITLE';r[3].func='PRIVATE_SOURCE';r[3].extra_private='PRIVATE_VALUE';
  const out=nodeRead(r,reviewed,read(),ctx), serialized=JSON.stringify(out);
  assert.equal(out.node.title,null);assert.equal(out.text,'');assert.ok(out.field_drift.some(x=>x.field==='func'&&!x.reviewed_match));
  for(const value of ['PRIVATE_TITLE','PRIVATE_SOURCE','PRIVATE_VALUE','extra_private']) assert.ok(!serialized.includes(value));
});
test('matched public source still redacts secrets and personal literals before chunking', () => {
  const r=data();r[3].func=`const password = "PASSWORD_PRIVATE"; const jwt="eyJ12345678.abcdefghijk.abcdefghijk"; const auth="Bearer ABC_PRIVATE_TOKEN"; const gh="ghp_ABCDEFGHIJKLMNO"; const url="https://user:PRIVATE_PASS@example.invalid/api?token=PRIVATE_QUERY"; const email="PRIVATE_NAME@example.invalid"; const lat=-23.123456; const phone="+55 11 98888-7777"; const address="Rua Private, 123"; return msg;`;
  const out=nodeRead(r,r,read(),ctx), text=out.text;
  for(const value of ['PASSWORD_PRIVATE','eyJ12345678','ABC_PRIVATE_TOKEN','ghp_ABCDEFGHIJKLMNO','PRIVATE_PASS','PRIVATE_QUERY','PRIVATE_NAME','-23.123456','98888-7777','Rua Private']) assert.ok(!text.includes(value),value);
  assert.ok(out.redacted_fields.length>=8);
  for(let offset=0;offset<text.length;offset+=7) assert.equal(nodeRead(r,r,read({offset,limit:7}),ctx).text,text.slice(offset,offset+7));
});
test('matched parameters redact sensitive keys and nested source values', () => {
  const r=data();r[3].credentials={password:'PRIVATE_PASSWORD'};r[3].env=[{name:'TOKEN',value:'PRIVATE_ENV'}];r[3].settings={normal:true,email:'PRIVATE_EMAIL',nested:'Bearer PRIVATE_TOKEN'};r[3].vehicle_vin='PRIVATE_VIN';
  const out=nodeRead(r,r,read({view:'parameters'}),ctx), serialized=JSON.stringify(out.parameters);
  for(const value of ['PRIVATE_PASSWORD','PRIVATE_ENV','PRIVATE_EMAIL','PRIVATE_TOKEN','PRIVATE_VIN']) assert.ok(!serialized.includes(value));
  assert.equal(out.parameters.outputs,1);assert.equal(out.parameters.settings.normal,true);assert.ok(out.redacted_fields.some(x=>x.field==='credentials'));
});
test('source chunk offsets apply to full sanitized text with stable hash', () => {
  const r=data();const all=nodeRead(r,r,read(),ctx);const one=nodeRead(r,r,read({limit:5}),ctx);const two=nodeRead(r,r,read({offset:5,limit:5}),ctx);
  assert.equal(one.text+two.text,all.text.slice(0,10));assert.equal(one.sanitized_source_sha256,two.sanitized_source_sha256);assert.equal(one.pagination.next_offset,5);
});
test('bounds, unknown views, malformed rows, duplicate IDs and future observations fail closed', () => {
  const r=data();for(const patch of [{offset:-1},{offset:262145},{limit:0},{limit:4097},{view:'context'},{view:'logs'},{offset:2,view:'parameters'}]) refuses(()=>nodeRead(r,r,read(patch),ctx));
  refuses(()=>inventory(r,r,inv({page_size:17}),ctx));refuses(()=>inventory([...r,r[0]],r,inv(),ctx));refuses(()=>inventory([{id:'ok',type:'../PRIVATE'}],r,inv(),ctx));
  refuses(()=>inventory(r,r,inv(),{...ctx,now:'2026-10-26T15:00:00.000Z'}));
});
test('opaque IDs use Map safely without prototype collisions', () => {
  const r=[{id:'constructor',type:'tab',label:'Public'},{id:'toString',type:'function',z:'constructor',func:'return msg;'}];
  assert.equal(inventory(r,r,inv({flow_id:'constructor'}),ctx).items[0].id,'toString');assert.ok(nodeRead(r,r,read({node_id:'toString'}),ctx).text.includes('return msg;'));
});
test('readonly projections do not mutate deeply frozen caller input', () => {
  const r=frozen(data()), reviewed=frozen(data()), context=frozen({...ctx}), args=frozen(inv()), ra=frozen(read());
  const before=JSON.stringify([r,reviewed,context,args,ra]);inventory(r,reviewed,args,context);nodeRead(r,reviewed,ra,context);assert.equal(JSON.stringify([r,reviewed,context,args,ra]),before);
});
test('numeric possible coordinates withheld and private parameter hashes not published', () => {
  const r=data();r[3].settings={ordinary:2,precise:-23.123456};r[3].password='PRIVATE_PASSWORD';
  const out=nodeRead(r,r,read({view:'parameters'}),ctx);
  assert.equal(out.parameters.settings.ordinary,2);assert.equal(out.parameters.settings.precise,'[REDACTED:possible_coordinate_literal]');
  const secret=out.field_drift.find(x=>x.field==='password');assert.equal(secret.runtime_sha256,null);assert.equal(secret.reviewed_sha256,null);
  assert.ok(out.field_drift.find(x=>x.field==='func').runtime_sha256);
});
test('large connections remain bounded with explicit total and truncation metadata', () => {
  const r=data();r[3].wires=[Array(300).fill('node-b')];
  const out=nodeRead(r,r,read({view:'metadata'}),ctx);
  assert.equal(out.node.connections.length,256);assert.equal(out.node.connections_total,300);assert.equal(out.node.connections_truncated,true);
});
test('snapshot excludes private values and source hashes never fingerprint divergent private code', () => {
  const reviewed=data(),one=data(),two=data();one[3].func='PRIVATE_ONE';two[3].func='PRIVATE_TWO';one[3].password='PASSWORD_ONE';two[3].password='PASSWORD_TWO';
  const a=inventory(one,reviewed,inv(),ctx),b=inventory(two,reviewed,inv(),ctx);assert.equal(a.snapshot_id,b.snapshot_id);
  const drift=nodeRead(one,reviewed,read(),ctx).field_drift.find(x=>x.field==='func');assert.equal(drift.runtime_sha256,null);assert.equal(drift.hash_basis,null);
  assert.notEqual(a.snapshot_id,inventory(two,reviewed,inv(),{...ctx,snapshot_nonce:'b'.repeat(32)}).snapshot_id);
});
const {createVirtualResources}=require('./virtual-resources.cjs');
const nowISO='2026-10-26T16:00:03.000Z';
function resourceFiles(p,s,resource_id=null,extra={}) {return p.files({host:'raspberry',snapshot_id:s.snapshot_id,resource_id,page_size:16,cursor:null,...extra},nowISO);}
function document(p,resource_id,time=nowISO) {let text='',offset=0;do{const out=p.read({host:'raspberry',resource_id,offset,limit:4096},time);text+=out.text;offset=out.pagination.next_offset;}while(offset!==null);return JSON.parse(text);}
const resourceRefuses=fn=>assert.throws(fn,e=>/^virtual_nodered_[a-z_]+$/.test(e.message)&&e.message===e.code);
test('virtual roots, flow node pages and global configuration discovery are lazy',()=>{
  const p=createVirtualResources(),r=data(),s=p.seed(r,r,ctx);
  assert.match(s.root_resource_id,/^[a-f0-9]{32}$/);assert.equal(p.stats(nowISO).documents,0);assert.equal(p.stats(nowISO).source_documents_built,0);
  const root=resourceFiles(p,s);const flow=root.items.find(x=>x.flow_id==='flow-a');assert.ok(flow);assert.ok(root.items.find(x=>x.kind==='all_nodes'));
  const nodes=resourceFiles(p,s,flow.resource_id);assert.equal(nodes.items.length,6);assert.equal(p.stats(nowISO).source_documents_built,0);
  const source=nodes.items.find(x=>x.node_id==='node-a'&&x.view==='source');const doc=document(p,source.resource_id);
  assert.ok(doc.text.includes('return msg;'));assert.equal(p.stats(nowISO).source_documents_built,1);assert.equal(doc.functional_recovery_proven,false);
  const all=resourceFiles(p,s,root.items.find(x=>x.kind==='all_nodes').resource_id);assert.ok(all.items.find(x=>x.node_id==='config-a'));
});
test('virtual IDs stable, source chunks <=4096, and complete JSON reads remain consistent',()=>{
  const p=createVirtualResources(),r=data();r[3].func='// public padding\n'+'x'.repeat(9000);const s=p.seed(r,r,ctx),root=resourceFiles(p,s),flow=root.items.find(x=>x.flow_id==='flow-a');
  const nodes=resourceFiles(p,s,flow.resource_id),source=nodes.items.find(x=>x.node_id==='node-a'&&x.view==='source');const first=document(p,source.resource_id);
  assert.equal(first.text.length,4096);assert.equal(first.resources.length,1);const second=document(p,first.resources[0].resource_id);assert.equal(second.text.length,4096);
  const again=p.seed(r,r,{...ctx,now:nowISO});assert.equal(again.root_resource_id,s.root_resource_id);assert.equal(resourceFiles(p,s,flow.resource_id).items.find(x=>x.node_id==='node-a'&&x.view==='source').resource_id,source.resource_id);
});
test('virtual file pagination bound to resource, page size and snapshot',()=>{
  const p=createVirtualResources(),r=data(),s=p.seed(r,r,ctx),first=resourceFiles(p,s,null,{page_size:1});assert.ok(first.pagination.next_cursor);
  const second=resourceFiles(p,s,null,{page_size:1,cursor:first.pagination.next_cursor});assert.notEqual(first.items[0].resource_id,second.items[0].resource_id);
  resourceRefuses(()=>resourceFiles(p,s,null,{page_size:2,cursor:first.pagination.next_cursor}));
  resourceRefuses(()=>p.files({host:'raspberry',snapshot_id:s.snapshot_id,resource_id:first.items[0].resource_id,page_size:1,cursor:first.pagination.next_cursor},nowISO));
});
test('virtual cache expires <=120s after observation and reseeding does not renew TTL',()=>{
  const p=createVirtualResources(),r=data(),s=p.seed(r,r,ctx);p.seed(r,r,{...ctx,now:'2026-10-26T16:01:00.000Z'});
  resourceRefuses(()=>p.read({host:'raspberry',resource_id:s.root_resource_id,offset:0,limit:4096},'2026-10-26T16:02:00.000Z'));
  assert.deepEqual({...p.stats('2026-10-26T16:02:00.000Z'),limits:undefined},{snapshots:0,resources:0,documents:0,source_documents_built:0,limits:undefined});
});
test('virtual input copies, closed arguments and same-ID private reassignment are protected',()=>{
  const p=createVirtualResources(),reviewed=data(),r=data();r[3].func='PRIVATE_ONE';const s=p.seed(r,reviewed,ctx);r[3].func='PRIVATE_TWO';
  resourceRefuses(()=>p.seed(r,reviewed,ctx));const doc=document(p,s.root_resource_id);assert.equal(doc.snapshot_id,s.snapshot_id);
  resourceRefuses(()=>p.read({host:'raspberry',resource_id:s.root_resource_id,offset:0,limit:4096,path:'/etc/passwd'},nowISO));
  resourceRefuses(()=>p.read({host:'raspberry',resource_id:'../../PRIVATE',offset:0,limit:4096},nowISO));
  resourceRefuses(()=>createVirtualResources({ttlMs:120001}));
});
test('virtual raw/document/resource/cache bounds fail closed without private exports',()=>{
  const r=data();r[3].large='x'.repeat(20000);resourceRefuses(()=>createVirtualResources({maxRawBytes:10}).seed(r,r,ctx));
  const p=createVirtualResources({maxDocuments:1,maxDocumentBytes:8192,maxResources:32,maxSnapshots:1}),s=p.seed(r,r,ctx);const root=resourceFiles(p,s);const flow=root.items.find(x=>x.flow_id==='flow-a');resourceFiles(p,s,flow.resource_id);
  assert.ok(p.stats(nowISO).documents<=1);const src=resourceFiles(p,s,flow.resource_id).items.find(x=>x.view==='parameters'&&x.node_id==='node-a');const doc=document(p,src.resource_id);assert.equal(doc.collection_error,'document_limit_exceeded');assert.equal(doc.resources.length,0);
  const s2=p.seed(r,r,{...ctx,snapshot_nonce:'d'.repeat(32)});assert.notEqual(s.snapshot_id,s2.snapshot_id);resourceRefuses(()=>document(p,s.root_resource_id));
});
test('virtual resource IDs derive from safe snapshot identity, not private raw values',()=>{
  const reviewed=data(),one=data(),two=data();one[3].func='PRIVATE_ONE';two[3].func='PRIVATE_TWO';const a=createVirtualResources().seed(one,reviewed,ctx),b=createVirtualResources().seed(two,reviewed,ctx);
  assert.equal(a.root_resource_id,b.root_resource_id);assert.equal(a.snapshot_id,b.snapshot_id);
});
test('virtual descriptor budget never permits unbounded lazy expansion',()=>{
  const r=data(),p=createVirtualResources({maxResources:1}),s=p.seed(r,r,ctx);
  resourceRefuses(()=>resourceFiles(p,s));assert.equal(p.stats(nowISO).resources,1);assert.equal(p.stats(nowISO).documents,0);
});
