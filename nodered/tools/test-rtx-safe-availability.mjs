import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const flows=JSON.parse(fs.readFileSync(new URL('../flows.json',import.meta.url)));
const nodes=new Map(flows.map(n=>[n.id,n]));
const get=(obj,key)=>key.split('.').reduce((v,k)=>v?.[k],obj);
function runtime(values=new Map()) {
 const flow={get:(key,store)=>values.get((store||'memory')+':'+key),set:(key,value,store)=>values.set((store||'memory')+':'+key,value)};
 const visited=[];let effects=0;
 const run=(start,message)=>{
  const queue=[[start,structuredClone(message)]];let steps=0;
  while(queue.length){assert(++steps<200,'cycle');const [id,msg]=queue.shift();const n=nodes.get(id);assert(n,'missing '+id);visited.push(id);
   const send=(idx,m)=>{if(m)for(const target of n.wires?.[idx]||[])queue.push([target,structuredClone(m)]);};
   if(n.type==='link out'){for(const target of n.links)queue.push([target,msg]);continue;}
   if(n.type==='link in'){send(0,msg);continue;}
   if(n.type==='function'){
    const result=vm.runInNewContext('(function(){'+n.func+'})()',{msg,flow,env:{get:()=> 'fixture-token'},node:{status(){},log(){},error(){throw Error('node.error');}},Date,Math,JSON,Number,String,Object,Array});
    if(Array.isArray(result))result.forEach((m,i)=>send(i,m));else send(0,result);continue;
   }
   if(n.type==='switch'){
    const v=get(msg,n.property);let match=false;
    for(let i=0;i<n.rules.length;i++){const r=n.rules[i];const rhs=r.vt==='msg'?get(msg,r.v):r.vt==='num'?Number(r.v):r.v;
      const pass=({true:()=>v===true,false:()=>v===false,lte:()=>v<=rhs,gte:()=>v>=rhs,lt:()=>v<rhs,else:()=>!match})[r.t]();
      if(pass){send(i,msg);match=true;if(n.checkall!=='true')break;}
    }continue;
   }
   if(n.type==='http request'){effects++;continue;}
   throw Error('Unexpected effect/type '+n.type);
  }
 };
 const policy={complete:true,confirmation_seconds:90,retry_seconds:300,max_attempts:2,freshness_seconds:120};flow.set('rtx_auto_policy_v1',policy,'persistent');
 return {flow,values,run,visited,get effects(){return effects;}};
}
const now=1_800_000_000_000;
function observation(extra={}){return {test_mode:true,rtx_now:now,rtx_status:{available:false,state:'LOCAL_AI_UNAVAILABLE',checked_at:new Date(now).toISOString()},rtx_host_entity:{state:'online',last_updated:new Date(now).toISOString()},...extra};}
function seed(r,extra={}){r.flow.set('rtx_auto_lifecycle_test',{first_failure_at:now-100000,last_attempt_at:0,attempts:0,pending:false,blocked:false,...extra});}
const entry='rtx_auto_facts';
const ok=runtime();seed(ok);ok.run(entry,observation());assert(ok.visited.includes('rtx_auto_dry_terminal'));assert.equal(ok.effects,0);assert.equal(ok.flow.get('rtx_auto_lifecycle_test').attempts,1);assert.equal(ok.flow.get('rtx_auto_lifecycle_test').pending,false);
const count=ok.visited.filter(x=>x==='rtx_auto_dry_terminal').length;ok.run(entry,observation());assert.equal(ok.visited.filter(x=>x==='rtx_auto_dry_terminal').length,count,'duplicate bypassed cooldown');
for(const state of [{attempts:2},{pending:true},{blocked:true},{first_failure_at:now-10000}]){const r=runtime();seed(r,state);r.run(entry,observation());assert(!r.visited.includes('rtx_auto_final_guard'));assert.equal(r.effects,0);}
for(const state of ['offline','unknown']){const r=runtime();seed(r);r.run(entry,observation({rtx_host_entity:{state,last_updated:new Date(now).toISOString()}}));assert(!r.visited.includes('rtx_auto_final_guard'));assert.equal(r.flow.get('rtx_auto_lifecycle_test').first_failure_at,now);}
const stale=runtime();seed(stale);stale.run(entry,observation({rtx_status:{available:false,state:'LOCAL_AI_UNAVAILABLE',checked_at:new Date(now-121000).toISOString()}}));assert(!stale.visited.includes('rtx_auto_final_guard'));
const missing=runtime();seed(missing);missing.flow.set('rtx_auto_policy_v1',{},'persistent');missing.run(entry,observation());assert(!missing.visited.includes('rtx_auto_final_guard'));
const recovered=runtime();seed(recovered,{attempts:2,blocked:true,last_attempt_at:now-1000});recovered.run(entry,observation({rtx_status:{available:true,state:'LOCAL_AI_AVAILABLE',checked_at:new Date(now).toISOString()}}));assert.equal(recovered.flow.get('rtx_auto_lifecycle_test').attempts,0);
const production=runtime();production.flow.set('rtx_auto_lifecycle_v1',{first_failure_at:now-100000,last_attempt_at:0,attempts:0,pending:false,blocked:false},'persistent');production.run(entry,observation({test_mode:false}));assert.equal(production.effects,1);assert(production.flow.get('rtx_auto_lifecycle_v1','persistent').pending);
const restarted=runtime(production.values);restarted.run(entry,observation({test_mode:false,rtx_now:now+400000,rtx_status:{available:false,state:'LOCAL_AI_UNAVAILABLE',checked_at:new Date(now+400000).toISOString()},rtx_host_entity:{state:'online',last_updated:new Date(now+400000).toISOString()}}));assert.equal(restarted.effects,0,'restart lost pending operation');
const id=production.flow.get('rtx_auto_lifecycle_v1','persistent').operation_id;production.run('rtx_auto_result',{test_mode:false,payload:{operation_id:'wrong-operation',outcome:'ready'}});assert(production.flow.get('rtx_auto_lifecycle_v1','persistent').blocked);
assert.equal(ok.flow.get('rtx_auto_lifecycle_v1','persistent'),undefined,'test polluted production');
console.log('PASS: actual visual gates, stale/offline/unknown, retry limit, cooldown, restart, correlation and full dry-run');
