const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/task_rpc.cjs','utf8').replaceAll('${EVA_PROJECT_ID}','aaaaaaaa-0000-0000-0000-000000000000');const box={module:{exports:{}},require:n=>n.endsWith('/vendor/ws')?class{}:n.endsWith('codex_control_rpc.cjs')?{metadata:(t,id)=>{assert.equal(t.id,id);return {cwd_is_project:t.cwd==='/mnt/data/docker',status:t.status,can_accept_direct_input:t.status==='idle'};}}:require(n),process:{argv:[]},console};vm.runInNewContext(source+'\nmodule.exports.ready=ready;',box);const m=box.module.exports;
const native={cwd:'/mnt/data/docker',approvalPolicy:'on-request',approvalsReviewer:'user',modelProvider:'openai',model:'fixture',sandbox:{type:'dangerFullAccess'}};
assert.equal(m.broadProfile(native),true);
for(const key of ['cwd','approvalPolicy','approvalsReviewer','modelProvider','model','sandbox']){let r={...native};delete r[key];assert.equal(m.broadProfile(r),false,key);}
assert.equal(m.broadProfile({...native,approvalPolicy:'never'}),false);
const p=m.profileParams('broad');assert.equal(p.sandbox,'danger-full-access');assert.equal(p.approvalPolicy,'on-request');assert.equal(p.approvalsReviewer,'user');assert.equal('permissions'in p,false);
const report={operation_id:'a'.repeat(32),source_set_sha256:'b'.repeat(64),validation_profile_sha256:'c'.repeat(64),render_sha256:'d'.repeat(64),render_png_sha256:'e'.repeat(64),source_review:'passed',visual_review:'passed',render_tool:'view_image',disposition:'approve'};
assert.equal(JSON.stringify(m.technicalReview(JSON.stringify({component_technical_review:report}))),JSON.stringify(report));assert.equal(m.technicalReview(JSON.stringify({component_technical_review:{...report,extra:'private'}})),null);assert.equal(m.technicalReview(JSON.stringify({component_technical_review:{...report,render_tool:'tests'}})),null);
assert.throws(()=>m.validate({mode:'observe',profile:'eva_broad',thread_id:'aaaaaaaa-0000-0000-0000-000000000000',operation_id:'a'.repeat(32),turn_id:'bbbbbbbb-0000-0000-0000-000000000000'}));
(async()=>{
 const id='bbbbbbbb-0000-0000-0000-000000000000',project='aaaaaaaa-0000-0000-0000-000000000000';
 const thread={id,projectId:project,cwd:'/mnt/data/docker',ephemeral:false,modelProvider:'openai',status:'idle'};
 let calls=[];
 const rpc=async(name,args)=>{calls.push(name);if(name==='thread/read')return {thread};if(name==='thread/resume'){assert.equal(args.approvalPolicy,'on-request');assert.equal(args.approvalsReviewer,'user');return {...native,thread};}throw Error(name);};
 await m.ready(rpc,id,'broad',project);assert.deepEqual(calls,['thread/read','thread/resume','thread/read']);
 calls=[];await assert.rejects(()=>m.ready(async(name,args)=>{const r=await rpc(name,args);return calls.length===3?{thread:{...thread,status:'active'}}:r;},id,'broad',project),/thread_profile_changed/);
 console.log('broad RPC assertions passed; exact resume and second independent readback verified');
})().catch(e=>{console.error(e);process.exitCode=1;});
