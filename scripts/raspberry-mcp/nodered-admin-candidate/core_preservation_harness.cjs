'use strict';
/* Uninstalled isolated Core-module harness. Public source fixtures only.
 * Run unprivileged by the principal, never from production/MCP. No network,
 * actual filesystem store, credentials or runtime data enter the sandbox.
 * Fails closed on unsupported requires/export contracts; no inferred PASS.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const CORE = '/usr/src/node-red/node_modules/@node-red/runtime/lib/';
const FIXED = {
  'credentials.js': CORE + 'nodes/credentials.js',
  'util.js': CORE + 'flows/util.js',
  'context-index.js': CORE + 'nodes/context/index.js'
};
const sha = body => crypto.createHash('sha256').update(body).digest('hex');
const results = [];
const sourceHashes = {};
let currentCase = 'fixture_loading';
function readFixtures(directory) {
  const directoryInfo = fs.lstatSync(directory);
  assert(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink());
  const metadataPath = path.join(directory, 'source-metadata.json');
  const info = fs.lstatSync(metadataPath);
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.core_version, '5.0.9');
  assert.deepEqual(Object.keys(metadata.sources).sort(), Object.values(FIXED).sort());
  const sources = {};
  for (const [filename, runtimePath] of Object.entries(FIXED)) {
    const fixedPath = path.join(directory, filename);
    const item = fs.lstatSync(fixedPath);
    assert(item.isFile() && !item.isSymbolicLink() && item.size <= 2 * 1024 ** 2);
    const body = fs.readFileSync(fixedPath);
    assert.match(metadata.sources[runtimePath], /^[a-f0-9]{64}$/);
    assert.equal(sha(body), metadata.sources[runtimePath]);
    sourceHashes[runtimePath] = sha(body);
    sources[filename] = body.toString('utf8');
  }
  return sources;
}
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
const logs = [];
const log = new Proxy({}, {get: (_, key) => key === '_' ? ((s) => s) : ((...args) => {logs.push(args.map(a => typeof a));})});
// Each load creates fresh stores; fake localfilesystem is deliberately memory
// only. This proves Core decisions/calls, not persistence/flush or real I/O.
function storeFactory() {
  const scopes = new Map();
  const cleaned = [];
  function scope(id) {if (!scopes.has(id)) scopes.set(id, {}); return scopes.get(id);}
  return {
    scopes, cleaned,
    open() {return Promise.resolve();}, close() {return Promise.resolve();},
    get(id, key, callback) {const value=Array.isArray(key)?key.map(k=>scope(id)[k]):scope(id)[key]; if(callback)callback(null,value); else return value;},
    set(id, key, value, callback) {if(Array.isArray(key))key.forEach((k,i)=>scope(id)[k]=value[i]);else scope(id)[key]=value;if(callback)callback();},
    keys(id, callback) {const value=Object.keys(scope(id));if(callback)callback(null,value);else return value;},
    delete(id) {scopes.delete(id);return Promise.resolve();},
    clean(active) {cleaned.push(clone(active));const ids=new Set(Array.isArray(active)?active:Object.keys(active||{}));for(const id of scopes.keys()){if(id!=='global'&&!ids.has(id)&&!ids.has(id.split(':')[0]))scopes.delete(id);}return Promise.resolve();}
  };
}
function loadModule(source, filename, supplied) {
  const module = {exports:{}};
  const safeRequire = name => {
    if(Object.prototype.hasOwnProperty.call(supplied,name))return supplied[name];
    throw new Error('unsupported_stub_dependency:' + filename + ':' + name);
  };
  // No process, Buffer or global host require. Any fs/network/timer access must
  // be explicitly represented by an in-memory stub below or fails closed.
  vm.runInNewContext(source,{module,exports:module.exports,require:safeRequire,
    __filename:'/synthetic/'+filename,__dirname:'/synthetic',console:log,
    setImmediate:fn=>fn(),clearImmediate:()=>{}}, {filename,timeout:1500});
  return module.exports;
}
const redUtil = {
  log, i18n:{_:s=>s},
  util:{cloneMessage:clone,ensureString:v=>String(v),parseContextStore:key=>({key}),
    getObjectProperty:(obj,key)=>key.split('.').reduce((v,k)=>v&&v[k],obj),
    setObjectProperty:(obj,key,value)=>{obj[key]=value;return true;},
    compareObjects:(a,b)=>JSON.stringify(a)===JSON.stringify(b),
    generateId:()=> 'synthetic-generated-id'}
};
const whenStub = Object.assign(value=>Promise.resolve(value),{resolve:Promise.resolve.bind(Promise),
  all:Promise.all.bind(Promise),reject:Promise.reject.bind(Promise),
  defer:()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}});
async function runCase(name,fn) {currentCase=name;await fn();results.push({name,passed:true});}
async function main() {
  assert.equal(process.argv.length,3,'one public source fixture directory required');
  const sources=readFixtures(path.resolve(process.argv[2]));
  const stores=[];
  function factory(){const s=storeFactory();stores.push(s);return s;}
  const context=loadModule(sources['context-index.js'],'context-index.js',{
    'util':require('node:util'),'@node-red/util':redUtil,'when':whenStub,
    './memory':factory,'./localfilesystem':factory,'memory':factory,'localfilesystem':factory,
    'clone':clone,'path':require('node:path')
  });
  const settings={contextStorage:{default:'memoryOnly',memoryOnly:{module:'memory'},persistent:{module:'localfilesystem'}},
    functionGlobalContext:{},get:key=>settings[key]};
  assert.equal(typeof context.init,'function');assert.equal(typeof context.get,'function');assert.equal(typeof context.clean,'function');
  context.init(settings);
  if(context.load)await context.load();
  const node='synthetic_node',flow='synthetic_flow';
  const config={allNodes:{[flow]:{id:flow,type:'tab'},[node]:{id:node,type:'function',z:flow}},flows:{[flow]:{id:flow,type:'tab',nodes:{[node]:{id:node,type:'function',z:flow}}}},subflows:{}};
  await runCase('core_context_retains_id_memory_and_fake_persistent',async()=>{
    const ctx=context.get(node,flow);ctx.set('public_counter',17,'memoryOnly');ctx.set('public_persistent',23,'persistent');
    context.getFlowContext(flow).set('public_flow',31,'persistent');
    await context.clean(config);
    assert.equal(context.get(node,flow).get('public_counter','memoryOnly'),17);
    assert.equal(context.get(node,flow).get('public_persistent','persistent'),23);
  });
  await runCase('core_context_disable_restore_retains_id',async()=>{
    const disabled=clone(config);disabled.allNodes[node].d=true;disabled.allNodes[flow].disabled=true;disabled.flows[flow].nodes[node].d=true;
    await context.delete(node,flow);await context.delete(flow);
    await context.clean(disabled);assert.equal(context.get(node,flow).get('public_counter','memoryOnly'),17);
    assert.equal(context.getFlowContext(flow).get('public_flow','persistent'),31);
    await context.clean(config);assert.equal(context.get(node,flow).get('public_counter','memoryOnly'),17);
  });
  await runCase('core_context_removed_id_is_not_claimed_preserved',async()=>{
    await context.clean({allNodes:{},flows:{[flow]:{id:flow,type:'tab',nodes:{}}},subflows:{}});
    assert.notEqual(context.get(node,flow).get('public_counter','memoryOnly'),17);
  });
  // Credentials receive synthetic data only; crypto/random/fs stubs fail if
  // touched. We exercise clean retention, never load a real encrypted file.
  const credentials=loadModule(sources['credentials.js'],'credentials.js',{
    '@node-red/util':redUtil,'crypto':new Proxy({},{get:()=>()=>{throw Error('crypto_not_allowed_in_clean_test');}}),
    'fs-extra':new Proxy({},{get:()=>()=>{throw Error('fs_not_allowed_in_clean_test');}}),
    'when':whenStub,'util':require('node:util'),'clone':clone,
    '../util':redUtil.util,'./registry':{get:()=>null}
  });
  const syntheticRuntime={settings:{get:()=>undefined,set:()=>{}},storage:{getCredentials:()=>Promise.resolve({}),saveCredentials:()=>Promise.resolve()},log,nodes:{getType:()=>null}};
  assert.equal(typeof credentials.init,'function');credentials.init(syntheticRuntime);
  assert.equal(typeof credentials.add,'function');assert.equal(typeof credentials.get,'function');assert.equal(typeof credentials.clean,'function');
  await runCase('core_credentials_retained_id_clean_no_decrypt',async()=>{
    credentials.add(node,{public_fixture:'synthetic_only'});await credentials.clean(Object.values(config.allNodes));
    assert.equal(credentials.get(node).public_fixture,'synthetic_only');
  });
  await runCase('core_credentials_disable_restore_same_id',async()=>{
    await credentials.clean([{id:node,d:true}]);assert.equal(credentials.get(node).public_fixture,'synthetic_only');
    await credentials.clean(Object.values(config.allNodes));assert.equal(credentials.get(node).public_fixture,'synthetic_only');
  });
  const util=loadModule(sources['util.js'],'util.js',{
    '@node-red/util':redUtil,'@node-red/registry':{get:()=>({})},'rfdc':()=>clone,
    'util':require('node:util'),'when':whenStub,'clone':clone,
    '../nodes':{},'../nodes/registry':{get:()=>({})},'../nodes/context':context,
    '../nodes/credentials':credentials,'path':require('node:path')
  });
  assert.equal(typeof util.parseConfig,'function');
  await runCase('core_parseconfig_disabled_id_retained',async()=>{
    const parsed=util.parseConfig([{id:flow,type:'tab'},{id:node,type:'function',z:flow,d:true}]);
    assert(parsed&&parsed.allNodes&&Object.prototype.hasOwnProperty.call(parsed.allNodes,node));
    const restored=util.parseConfig([{id:flow,type:'tab'},{id:node,type:'function',z:flow}]);
    assert(Object.prototype.hasOwnProperty.call(restored.allNodes,node));
  });
  process.stdout.write(JSON.stringify({schema_version:1,core_version:'5.0.9',passed:true,core_sha256:sourceHashes,
    cases:results,coverage:['actual_core_module_exports','in_memory_io_stubs','synthetic_ids_only','fake_persistent_store'],
    proves_full_runtime_deploy:false,proves_real_store_flush:false,proves_context_value_equality:false,
    proves_contrib_finalize_safety:false,logical_disable_restore_core_semantics_only:true})+'\n');
}
main().catch(error=>{
  process.stdout.write(JSON.stringify({schema_version:1,core_version:'5.0.9',passed:false,
    failed_case:currentCase,error_kind:error.name,reason:String(error.message).slice(0,220),
    core_sha256:sourceHashes,cases:results,no_runtime_or_private_data_used:true})+'\n');
  process.exitCode=1;
});
