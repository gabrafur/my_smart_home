const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const box={module:{exports:{}},require:name=>name==='/usr/local/lib/raspberry-ha-notices/vendor/ws'?class RefuseSocket{constructor(){throw Error('network forbidden');}}:require(name),process,Buffer,setTimeout,clearTimeout};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'repair_rpc.cjs'),'utf8'),box);
const api=box.module.exports;
const id=api.THREADS[0],OP='a'.repeat(32);
function fixture(status='idle',provider='openai'){
 const calls=[];
 const rpc=async(method,params)=>{calls.push({method,params});if(method==='thread/read')return {thread:{id,cwd:'/mnt/data/docker',modelProvider:provider,status:{type:status},canAcceptDirectInput:true}};if(method==='account/read')return {account:{type:'chatgpt',planType:'pro'}};if(method==='account/rateLimits/read')return {ordinaryUsageAllowed:true,rateLimits:{credits:{hasCredits:false,unlimited:false,balance:null}}};if(method==='turn/start')return {turn:{id:'11111111-1111-4111-8111-111111111111'}};throw Error('unexpected '+method);};return {calls,rpc};
}
test('notLoaded refuses without resume or turn send',async()=>{const f=fixture('notLoaded');await assert.rejects(api.run({mode:'preflight',thread_id:id},f.rpc),/legacy_resume_profile_unenrolled/);assert.deepEqual(f.calls.map(c=>c.method),['thread/read']);});
test('unknown provider refuses before quota or effects',async()=>{const f=fixture('idle','custom');await assert.rejects(api.run({mode:'preflight',thread_id:id},f.rpc),/profile_unconfirmed/);assert.equal(f.calls.length,1);});
test('fixed loaded send preserves profile and identity',async()=>{const f=fixture();const r=await api.run({mode:'send',thread_id:id,operation_id:OP,intent:'repair_health_summary'},f.rpc);assert.equal(r.operation_state,'accepted');assert(!f.calls.some(c=>c.method==='thread/resume'||c.method==='thread/start'));const q=f.calls.find(c=>c.method==='turn/start').params;assert.deepEqual(Object.keys(q).sort(),['clientUserMessageId','input','threadId']);assert.equal(q.threadId,id);assert.equal(q.clientUserMessageId,OP);});
test('scope still refuses caller prompt and model overrides',()=>{for(const key of ['prompt','model','sandbox','permissions'])assert.throws(()=>api.validate({mode:'send',thread_id:id,operation_id:OP,intent:'repair_health_summary',[key]:'x'}));});
