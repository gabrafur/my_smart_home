'use strict';
// Memory-only adapter for existing readonly file tools. No filesystem or network.
const crypto = require('node:crypto');
const model = require('./nodered_model.cjs');
const HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function refuse(code = 'virtual_nodered_resource_refused') { const error = new Error(code); error.code = code; throw error; }
function closed(args, fields) { if (!plain(args) || Object.keys(args).length !== fields.length || fields.some(k => !Object.hasOwn(args,k)) || args.host !== 'raspberry') refuse(); }
function instant(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) refuse(); return Date.parse(value); }
function createVirtualResources(options = {}) {
  const defaults = { ttlMs:120000, maxSnapshots:1, maxRawBytes:8388608, maxDocuments:32, maxDocumentBytes:65536, maxResources:4096 };
  if (!plain(options) || Object.keys(options).some(k => !Object.hasOwn(defaults,k))) refuse();
  const limits = {...defaults,...options};
  for (const k of Object.keys(defaults)) if (!Number.isInteger(limits[k]) || limits[k] < 1 || limits[k] > defaults[k]) refuse();
  const snapshots = new Map(), resources = new Map(), documents = new Map();
  let sourceDocumentsBuilt = 0;
  function removeSnapshot(id) {
    const row=snapshots.get(id);if(row?.expiryTimer)clearTimeout(row.expiryTimer);
    snapshots.delete(id);
    for (const [rid, row] of resources) if (row.snapshot_id === id) { resources.delete(rid); documents.delete(rid); }
  }
  function purge(now) { for (const [id,row] of snapshots) if (now >= row.expires_at) removeSnapshot(id); }
  function getSnapshot(id, now) {
    purge(now); const row=snapshots.get(id);
    if (!row || now < row.created_at) refuse('virtual_nodered_snapshot_unavailable');
    return row;
  }
  function add(snapshot_id, descriptor) {
    const resource_id=hash(JSON.stringify({namespace:'nodered_readonly_v1',snapshot_id,descriptor})).slice(0,32);
    if (!resources.has(resource_id)) {
      if (resources.size >= limits.maxResources) refuse('virtual_nodered_resource_budget_exhausted');
      resources.set(resource_id,{snapshot_id,descriptor});
    }
    return resource_id;
  }
  function link(snapshot_id, descriptor) { return {resource_id:add(snapshot_id,descriptor),kind:descriptor.kind,readonly:true,content_type:'application/json'}; }
  function envelope(snapshot, now) { return {source:'raspberry_NodeRED_virtual_readonly_resources',snapshot_id:snapshot.snapshot_id,observed_at:snapshot.context.observed_at,age_seconds:(now-Date.parse(snapshot.context.observed_at))/1000,collection_error:null,coverage:['runtime_snapshot_and_reviewed_public_projection','memory_cache_max_120_seconds','documents_materialized_on_demand','not_execution_readiness_or_functional_success'],expires_at:new Date(snapshot.expires_at).toISOString(),functional_recovery_proven:false}; }
  function render(resource_id, now) {
    const resource=resources.get(resource_id);
    if (!resource) refuse('virtual_nodered_resource_unavailable');
    const snapshot=getSnapshot(resource.snapshot_id,now);
    if (documents.has(resource_id)) { const hit=documents.get(resource_id); documents.delete(resource_id); documents.set(resource_id,hit); return {snapshot,...hit}; }
    const d=resource.descriptor, ctx=snapshot.context; let data, children=[];
    if (d.kind === 'flows' || d.kind === 'flow_nodes' || d.kind === 'all_nodes') {
      const inventory=model.inventory(snapshot.runtime,snapshot.reviewed,{host:'raspberry',kind:d.kind==='flows'?'flows':'nodes',flow_id:d.kind==='flow_nodes'?d.flow_id:null,page_size:16,cursor:d.cursor},ctx);
      data={...inventory,document_generated_at:ctx.now};
      if(d.kind!=='flows') data.items=inventory.items.map(({connections,...row})=>({...row,connections_omitted_in_inventory:true}));
      if (d.kind==='flows') {
        children=inventory.items.map(row=>({...link(snapshot.snapshot_id,{kind:'flow_nodes',flow_id:row.id,cursor:null}),flow_id:row.id,title:row.title}));
        // Configuration/global nodes remain discoverable without a flow filter.
        if (d.cursor===null) children.push(link(snapshot.snapshot_id,{kind:'all_nodes',cursor:null}));
      } else {
        children=inventory.items.flatMap(row=>['metadata','parameters','source'].map(view=>({...link(snapshot.snapshot_id,{kind:'node',node_id:row.id,view,source_offset:0}),node_id:row.id,view})));
      }
      if (inventory.pagination.next_cursor!==null) children.push({...link(snapshot.snapshot_id,{...d,cursor:inventory.pagination.next_cursor}),next_page:true});
      data.resources=children;
    } else if (d.kind==='node') {
      data=model.nodeRead(snapshot.runtime,snapshot.reviewed,{host:'raspberry',node_id:d.node_id,view:d.view,offset:d.source_offset,limit:4096},ctx);
      data.document_generated_at=ctx.now;
      if(d.view==='source') {
        sourceDocumentsBuilt++;
        if(data.pagination.next_offset!==null) children.push({...link(snapshot.snapshot_id,{...d,source_offset:data.pagination.next_offset}),next_source_chunk:true});
      }
      data.resources=children;
    } else refuse();
    let text=JSON.stringify(data);
    if(Buffer.byteLength(text,'utf8')>limits.maxDocumentBytes) {
      children=[];
      text=JSON.stringify({...envelope(snapshot,snapshot.created_at),collection_error:'document_limit_exceeded',redacted_fields:[{field:'document',reason:'document_limit_exceeded'}],resources:[]});
      if(Buffer.byteLength(text,'utf8')>limits.maxDocumentBytes) refuse('virtual_nodered_document_limit_exceeded');
    }
    const doc={text,children,document_generated_at:ctx.now};
    if(documents.size>=limits.maxDocuments) documents.delete(documents.keys().next().value);
    documents.set(resource_id,doc);
    return {snapshot,...doc};
  }
  function seed(runtime,reviewed,context) {
    // Caller supplies collection evidence and a fresh nonce/timestamp for each
    // new observation. JSON copies bound retained raw state and prevent mutation.
    if(!plain(context)||Object.keys(context).some(k=>!['observed_at','now','runtime_version','public_head','snapshot_nonce'].includes(k))||['observed_at','now','runtime_version','public_head'].some(k=>!Object.hasOwn(context,k)))refuse();
    if(JSON.stringify(context).length>1024)refuse();
    const now=instant(context?.now);purge(now);
    let raw,reviewedRaw;try {raw=JSON.stringify(runtime);reviewedRaw=JSON.stringify(reviewed);} catch {refuse();}
    if(typeof raw!=='string'||typeof reviewedRaw!=='string'||Buffer.byteLength(raw)+Buffer.byteLength(reviewedRaw)>limits.maxRawBytes) refuse('virtual_nodered_raw_limit_exceeded');
    const runtimeCopy=JSON.parse(raw),reviewedCopy=JSON.parse(reviewedRaw),ctx=JSON.parse(JSON.stringify(context));
    let first;try {first=model.inventory(runtimeCopy,reviewedCopy,{host:'raspberry',kind:'flows',flow_id:null,page_size:16,cursor:null},ctx);} catch {refuse();}
    if(now-Date.parse(ctx.observed_at)>limits.ttlMs) refuse('virtual_nodered_snapshot_unavailable');
    const id=first.snapshot_id;
    if(snapshots.has(id)) {
      const existing=getSnapshot(id,now);
      // No private-value fingerprint is exported. Reject reassignment of an ID
      // to different raw input; do not reset the original TTL on reseeding.
      if(existing.raw!==raw||existing.reviewedRaw!==reviewedRaw) refuse('virtual_nodered_snapshot_identity_conflict');
      return {...envelope(existing,now),root_resource_id:existing.root_resource_id};
    }
    if(snapshots.size>=limits.maxSnapshots) removeSnapshot(snapshots.keys().next().value);
    const snapshot={snapshot_id:id,runtime:runtimeCopy,reviewed:reviewedCopy,raw,reviewedRaw,context:ctx,created_at:now,expires_at:Math.min(now+limits.ttlMs,Date.parse(ctx.observed_at)+limits.ttlMs)};
    snapshots.set(id,snapshot);
    snapshot.expiryTimer=setTimeout(()=>removeSnapshot(id),snapshot.expires_at-now);
    snapshot.expiryTimer.unref?.();
    try {snapshot.root_resource_id=add(id,{kind:'flows',cursor:null});} catch(error) {removeSnapshot(id);throw error;}
    return {...envelope(snapshot,now),root_resource_id:snapshot.root_resource_id};
  }
  function files(args,nowISO) {
    closed(args,['host','snapshot_id','resource_id','page_size','cursor']);
    if(!HEX64.test(args.snapshot_id)||!(args.resource_id===null||(typeof args.resource_id==='string'&&HEX32.test(args.resource_id)))||!Number.isInteger(args.page_size)||args.page_size<1||args.page_size>16||!(args.cursor===null||(typeof args.cursor==='string'&&args.cursor.length<=512))) refuse();
    const now=instant(nowISO),snapshot=getSnapshot(args.snapshot_id,now),rid=args.resource_id||snapshot.root_resource_id;
    if(resources.get(rid)?.snapshot_id!==snapshot.snapshot_id) refuse();
    const doc=render(rid,now);let offset=0;
    if(args.cursor!==null) {
      let value;try {if(!/^[A-Za-z0-9_-]+$/.test(args.cursor))refuse();const b=Buffer.from(args.cursor,'base64url');if(b.toString('base64url')!==args.cursor)refuse();value=JSON.parse(b.toString('utf8'));}catch{refuse();}
      if(!plain(value)||Object.keys(value).sort().join(',')!=='offset,page_size,resource_id,snapshot_id'||value.snapshot_id!==snapshot.snapshot_id||value.resource_id!==rid||value.page_size!==args.page_size||!Number.isInteger(value.offset)||value.offset<1||value.offset%args.page_size!==0)refuse();offset=value.offset;
    }
    if(offset>doc.children.length)refuse();const end=Math.min(offset+args.page_size,doc.children.length);
    const next_cursor=end<doc.children.length?Buffer.from(JSON.stringify({snapshot_id:snapshot.snapshot_id,resource_id:rid,page_size:args.page_size,offset:end})).toString('base64url'):null;
    return {...envelope(snapshot,now),resource_id:rid,items:doc.children.slice(offset,end),pagination:{offset,page_size:args.page_size,total:doc.children.length,next_cursor}};
  }
  function read(args,nowISO) {
    closed(args,['host','resource_id','offset','limit']);
    if(typeof args.resource_id!=='string'||!HEX32.test(args.resource_id)||!Number.isInteger(args.offset)||args.offset<0||args.offset>262144||!Number.isInteger(args.limit)||args.limit<1||args.limit>4096)refuse();
    const now=instant(nowISO);purge(now);const doc=render(args.resource_id,now);
    if(args.offset>doc.text.length)refuse();const end=Math.min(args.offset+args.limit,doc.text.length);
    return {...envelope(doc.snapshot,now),resource_id:args.resource_id,content_type:'application/json',document_generated_at:doc.document_generated_at,text:doc.text.slice(args.offset,end),pagination:{offset:args.offset,limit:args.limit,total_characters:doc.text.length,next_offset:end<doc.text.length?end:null}};
  }
  function stats(nowISO) {purge(instant(nowISO));return {snapshots:snapshots.size,resources:resources.size,documents:documents.size,source_documents_built:sourceDocumentsBuilt,limits:{...limits}};}
  return Object.freeze({seed,files,read,stats});
}
module.exports={createVirtualResources};
