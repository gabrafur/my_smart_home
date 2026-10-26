const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {ReceiptStore,FixedNodeRedClient,NodeRedWorker,selected}=require('./nodered_effect.cjs');
const {normalizedIdentity}=require('../attestation_model.cjs');
const OP='a'.repeat(32),TASK='b'.repeat(32),PRINCIPAL='c'.repeat(64),COMPONENT='observacao_host',TAB='host_observer_tab';
function source(){return [{id:TAB,type:'tab',label:'synthetic',disabled:false,env:[],info:''},{id:'function_one',z:TAB,type:'function',name:'synthetic',func:'return msg;',outputs:1,initialize:'',finalize:'',wires:[[]]},{id:'other',type:'tab',label:'other scope'},{id:'outside',z:'other',type:'function',func:'return msg;',wires:[[]]}];}
function preparation(flows){const nodes=structuredClone(selected(flows,COMPONENT));nodes.find(n=>n.id==='function_one').func='msg.repaired = true; return msg;';return {operation_id:OP,task_id:TASK,principal_sha256:PRINCIPAL,component_id:COMPONENT,before_sha256:normalizedIdentity(selected(flows,COMPONENT)),after_sha256:normalizedIdentity(nodes),candidate_nodes:nodes};}
function grant(binding){return {...binding,identity_kind:'nodered_scoped_configuration_v1',registered_task:true,reviewed_candidate:true,principal_matches:true,shared_budget_reserved:true,global_admin_idle:true,resources_available:true,maintenance_lock_held:true,observed_at:1000,expires_at:2000};}
async function fixture(t,mode='success'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'component-worker-test-'));fs.chmodSync(root,0o700);const folder=path.join(root,'apply');fs.mkdirSync(folder,{mode:0o700});let intentFolder=folder;
 let flows=source(),revision='0'.repeat(64);const calls=[];
 const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=raw?JSON.parse(raw):{};calls.push([req.method,req.url]);res.setHeader('Content-Type','application/json');
  if(req.url==='/auth/token'){res.end(JSON.stringify({access_token:'PRIVACY_TEST_FIXTURE',expires_in:3600}));return;}
  if(req.url==='/auth/revoke'){res.statusCode=mode==='revoke-failure'?500:200;res.end('{}');return;}
  if(req.url==='/flows'&&req.method==='GET'){res.end(JSON.stringify({rev:revision,flows}));return;}
  if(req.url==='/flows'&&req.method==='POST'){
   assert.ok(fs.existsSync(path.join(intentFolder,OP,'intent.json')),'durable intent must precede network effect');
   assert.equal(req.headers['node-red-deployment-type'],'nodes');
   if(mode==='conflict'||body.rev!==revision){res.statusCode=409;res.end('{}');return;}
   flows=body.flows;revision=String(calls.filter(([method,url])=>method==='POST'&&url==='/flows').length).repeat(64);
   if(mode==='lost-response'){req.socket.destroy();return;}
   if(mode==='verification-mismatch')flows.find(n=>n.id==='outside').func='foreign change';
   res.end(JSON.stringify({rev:revision}));return;
  }
  res.statusCode=404;res.end('{}');
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 const client=new FixedNodeRedClient({host:'127.0.0.1',port:server.address().port,username:'synthetic',password:'PRIVACY_TEST_FIXTURE'});
 const store=new ReceiptStore(folder,'apply');const worker=new NodeRedWorker({client,store,purpose:'apply',admission:async binding=>grant(binding),clock:()=>1000});
 return {root,folder,client,store,worker,calls,expectIntentAt:dir=>{intentFolder=dir;},prepared:preparation(flows),flows:()=>flows};
}
test('real HTTP path commits intent, preserves other scope and returns one durable receipt',async t=>{
 const f=await fixture(t);const result=await f.worker.execute(f.prepared);
 assert.equal(result.state,'applied');assert.equal(result.receipt_verified,true);assert.equal(result.executor_terminal,true);assert.equal(result.session_revoked,true);
 assert.equal(f.flows().find(n=>n.id==='outside').func,'return msg;');
 const receipt=fs.readFileSync(path.join(f.folder,OP,'receipt.json'),'utf8');assert.doesNotMatch(receipt,/PRIVACY_TEST_FIXTURE|return msg|password|access_token/);
 const duplicate=await f.worker.execute(f.prepared);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.effect_repeated,false);
 assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,1);assert.equal(f.calls.filter(([,p])=>p==='/auth/revoke').length,1);
});
test('explicit revision rejection is recorded without retry or mutation',async t=>{
 const f=await fixture(t,'conflict');const result=await f.worker.execute(f.prepared);
 assert.equal(result.state,'rejected_without_effect');assert.equal(result.definitive_no_effect,true);assert.equal(result.effect_attempted,true);assert.equal(result.receipt_verified,true);
 assert.equal(f.flows().find(n=>n.id==='function_one').func,'return msg;');await f.worker.execute(f.prepared);
 assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,1);
});
for(const mode of ['lost-response','verification-mismatch'])test(`${mode} retains uncertainty even when the requested version may be present`,async t=>{
 const f=await fixture(t,mode);const result=await f.worker.execute(f.prepared);assert.equal(result.state,'uncertain');assert.equal(result.executor_terminal,false);assert.equal(result.session_revoked,true);
 const recovered=new NodeRedWorker({client:f.client,store:new ReceiptStore(f.folder,'apply'),purpose:'apply',admission:async b=>grant(b),clock:()=>1000});
 await recovered.execute(f.prepared);assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,1);
});
test('wrong task, stale grant, missing lock and expired admission stop before authentication',async t=>{
 const f=await fixture(t);
 for(const change of [{task_id:'d'.repeat(32)},{reviewed_candidate:false},{maintenance_lock_held:false},{observed_at:994},{expires_at:1080}]){
  f.worker.admission=async binding=>({...grant(binding),...change});await assert.rejects(f.worker.execute(f.prepared));
 }
 assert.equal(f.calls.length,0);assert.equal(fs.readdirSync(f.folder).length,0);
});
test('wire, node set and initialization changes cannot cross the deployment boundary',async t=>{
 for(const alter of [nodes=>{nodes.find(n=>n.id==='function_one').wires=[['outside']];},nodes=>{nodes.push({id:'new',z:TAB,type:'function',func:'return msg;'});},nodes=>{nodes.find(n=>n.id==='function_one').initialize='PRIVATE_TEST';}]) {
  const f=await fixture(t);const proposed=structuredClone(f.prepared);alter(proposed.candidate_nodes);proposed.after_sha256=normalizedIdentity(proposed.candidate_nodes);
  const result=await f.worker.execute(proposed);assert.equal(result.state,'rejected_without_effect');assert.equal(result.effect_attempted,false);assert.equal(result.receipt_verified,true);
  assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,0);
 }
});
test('existing intent is not resumed or repeated without a terminal receipt',async t=>{
 const f=await fixture(t);const {candidate_nodes,...fields}=f.prepared;const binding={...fields,action:'apply'};f.store.register(binding);f.store.begin(binding,selected(f.flows(),COMPONENT));
 const result=await f.worker.execute(f.prepared);assert.equal(result.state,'uncertain');assert.equal(result.executor_terminal,false);assert.equal(f.calls.length,0);
});
test('a conflicting reused operation ID and extra parameters are refused',async t=>{
 const f=await fixture(t);await f.worker.execute(f.prepared);
 await assert.rejects(f.worker.execute({...f.prepared,task_id:'d'.repeat(32)}),/operation_id_conflict/);
 await assert.rejects(f.worker.execute({...f.prepared,path:'/unapproved'}),/prepared_record_refused/);
 assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,1);
});
test('session cleanup failure is explicit and never represented as successful revocation',async t=>{
 const f=await fixture(t,'revoke-failure');const result=await f.worker.execute(f.prepared);assert.equal(result.state,'applied');assert.equal(result.session_revoked,false);
});

test('rollback uses protected backup, original operation ID and a distinct durable purpose',async t=>{
 const f=await fixture(t);await f.worker.execute(f.prepared);
 const previous=f.store.read(path.join(f.folder,OP,'scope-before.json'));
 const rollbackFolder=path.join(f.root,'rollback');fs.mkdirSync(rollbackFolder,{mode:0o700});f.expectIntentAt(rollbackFolder);
 const rollback=new NodeRedWorker({client:f.client,store:new ReceiptStore(rollbackFolder,'rollback'),purpose:'rollback',admission:async binding=>grant(binding),clock:()=>1000});
 const request={...f.prepared,before_sha256:f.prepared.after_sha256,after_sha256:f.prepared.before_sha256,candidate_nodes:previous};
 const result=await rollback.execute(request);assert.equal(result.state,'applied');assert.equal(result.action,'rollback');assert.equal(result.operation_id,OP);
 assert.equal(f.flows().find(n=>n.id==='function_one').func,'return msg;');assert.equal(result.loaded_sha256,f.prepared.before_sha256);
 await rollback.execute(request);assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,2);
 assert.equal(f.store.existing({...fields(f.prepared),action:'apply'}).state,'applied');
});
function fields(prepared){const {candidate_nodes,...binding}=prepared;return binding;}
test('tampered receipt identity cannot be substituted as another task result',async t=>{
 const f=await fixture(t);await f.worker.execute(f.prepared);const file=path.join(f.folder,OP,'receipt.json');const row=JSON.parse(fs.readFileSync(file));row.task_id='d'.repeat(32);fs.writeFileSync(file,JSON.stringify(row));
 await assert.rejects(f.worker.execute(f.prepared),/receipt_identity_mismatch/);
 assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,1);
});

test('coordinator response loss reconciles the real child receipt without another HTTP deploy',async t=>{
 const f=await fixture(t);const {spawn}=require('node:child_process');
 const runner=`const fs=require('node:fs');const {ReceiptStore,FixedNodeRedClient,NodeRedWorker}=require(process.env.TEST_EFFECT_MODULE);const prepared=JSON.parse(fs.readFileSync(0,'utf8'));const worker=new NodeRedWorker({client:new FixedNodeRedClient({host:'127.0.0.1',port:Number(process.env.TEST_EFFECT_PORT),username:'synthetic',password:'PRIVACY_TEST_FIXTURE'}),store:new ReceiptStore(process.env.TEST_EFFECT_STATE,'apply'),purpose:'apply',clock:()=>1000,admission:async binding=>({...binding,identity_kind:'nodered_scoped_configuration_v1',registered_task:true,reviewed_candidate:true,principal_matches:true,shared_budget_reserved:true,global_admin_idle:true,resources_available:true,maintenance_lock_held:true,observed_at:1000,expires_at:2000})});worker.execute(prepared).then(result=>console.log(JSON.stringify(result))).catch(()=>process.exitCode=1);`;
 const python=`import importlib.util,json,os,subprocess,sys\nfrom pathlib import Path\np=Path(os.environ['TEST_EFFECT_MODULE']).parent.parent/'workflow.py'\nspec=importlib.util.spec_from_file_location('tested_workflow',p);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nprepared=json.load(sys.stdin);op=prepared['operation_id'];base=prepared['before_sha256'];after=prepared['after_sha256']\nw=module.Workflow(Path(os.environ['TEST_EFFECT_STATE']).parent/'coordinator.sqlite3',lambda:1000,2000)\nw.prepare(op,prepared['component_id'],prepared['task_id'],base,after,{prepared['task_id']})\nw.validate(op,lambda row:{'base_sha256':base,'candidate_sha256':after,'isolated_tests_passed':True,'no_household_effects':True,'reviewed_scope':True})\ndef execute(row):\n result=subprocess.run([os.environ['TEST_NODE_BINARY'],'-e',os.environ['TEST_CHILD_RUNNER']],input=json.dumps(prepared).encode(),capture_output=True,timeout=10)\n assert result.returncode==0\n raise TimeoutError('synthetic_coordinator_response_loss')\nw.apply(op,lambda row:{'collection_error':None,'loaded_sha256':base},execute,global_admin_idle=True,resources_available=True)\nbefore=w.status(op)['state']\nproof=json.loads((Path(os.environ['TEST_EFFECT_STATE'])/op/'receipt.json').read_text())\nw.reconcile(op,lambda row:proof)\nprint(json.dumps({'before':before,'after':w.status(op)['state'],'operation_id':op,'task_id':w.status(op)['task_id']}));w.close()\n`;
 const env={...process.env,TEST_EFFECT_MODULE:path.join(__dirname,'nodered_effect.cjs'),TEST_EFFECT_PORT:String(f.client.binding.port),TEST_EFFECT_STATE:f.folder,TEST_NODE_BINARY:process.execPath,TEST_CHILD_RUNNER:runner};
 const outcome=await new Promise((resolve,reject)=>{
  const child=spawn('python3',['-I','-S','-B','-c',python],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const timeout=setTimeout(()=>{child.kill('SIGTERM');reject(Error('synthetic_protocol_timeout'));},15000);
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);
  child.on('exit',code=>{clearTimeout(timeout);if(code!==0)reject(Error(stderr));else resolve(JSON.parse(stdout));});child.stdin.end(JSON.stringify(f.prepared));
 });
 assert.equal(outcome.before,'uncertain');assert.equal(outcome.after,'applied_awaiting_functional_proof');assert.equal(outcome.operation_id,OP);assert.equal(outcome.task_id,TASK);
 assert.equal(f.calls.filter(([m,p])=>m==='POST'&&p==='/flows').length,1);
});
