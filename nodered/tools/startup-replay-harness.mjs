import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../package.json',import.meta.url));
const jsonata=require('jsonata');
export const flows=JSON.parse(fs.readFileSync(new URL('../flows.json',import.meta.url),'utf8'));
export function context() {const values=new Map();return {values,get(k,s='default'){return values.get(s+':'+k)},set(k,v,s='default'){values.set(s+':'+k,structuredClone(v))}};}
export function harness(){
 const by=new Map(flows.map(n=>[n.id,n]));const contexts=new Map();const global=context();const dry=[];const seen=[];let now=1000000;
 const flowFor=z=>{if(!contexts.has(z))contexts.set(z,context());return contexts.get(z)};
 const get=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
 const set=(o,p,v)=>{const ks=p.split('.');for(const k of ks.slice(0,-1))o=o[k]??={};if(v===undefined)delete o[ks.at(-1)];else o[ks.at(-1)]=v};
 async function run(id,message){const queue=[[id,structuredClone(message)]];let count=0;
 while(queue.length){if(++count>1200)throw Error('Replay loop');let [id,msg]=queue.shift();const n=by.get(id);if(!n)throw Error('Missing '+id);const flow=flowFor(n.z);seen.push(id);
 const emit=(port,m)=>{if(m!=null)for(const to of n.wires?.[port]||[])queue.push([to,structuredClone(m)])};
 if(n.type==='function'){
 const logs=[]; const node={status(){},warn(){},log(x){logs.push(x)},error(x){throw Error(id+': '+x)}};
 const out=new Function('msg','flow','node','global','Buffer','env','os',n.func)(msg,flow,node,global,Buffer,{get:()=>0},{uptime:()=>now/1000});
 if(id.endsWith('dry_run_terminal')||['startup_dry','startup_gate_dry'].includes(id))dry.push({id,msg:structuredClone(msg)});
 if(out!=null){const ports=Array.isArray(out)?out:[out];ports.forEach((m,i)=>{if(Array.isArray(m))m.forEach(v=>emit(i,v));else emit(i,m)})}
 }else if(n.type==='switch'){
 let v=n.propertyType==='jsonata'?await jsonata(n.property).evaluate(msg):get(msg,n.property);let matched=false;
 for(let i=0;i<n.rules.length;i++){const r=n.rules[i];const expected=r.vt==='num'?Number(r.v):r.v;const yes=r.t==='else'?!matched:r.t==='true'?v===true:r.t==='false'?v===false:r.t==='eq'?v===expected:r.t==='neq'?v!==expected:false;if(yes){matched=true;emit(i,msg);if(n.checkall==='false')break}}
 }else if(n.type==='change'){
 for(const r of n.rules||[]){let value=r.t==='delete'?undefined:r.tot==='msg'?get(msg,r.to):r.tot==='num'?Number(r.to):r.tot==='bool'?r.to==='true':r.tot==='json'?JSON.parse(r.to):r.to;
 if(r.pt==='flow'||r.pt==='global'){const target=r.pt==='global'?global:flow;const match=r.p.match(/^#:\(([^)]+)\)::(.*)$/);target.set(match?match[2]:r.p,value,match?match[1]:'default')}
 else set(msg,r.p,value)}emit(0,msg);
 }else if(n.type==='link in')emit(0,msg);
 else if(n.type==='link out'){for(const to of n.links||[])queue.push([to,structuredClone(msg)])}
 else if(n.type==='inject'){for(const p of n.props||[]){if(p.v!==undefined)set(msg,p.p,p.vt==='json'?JSON.parse(p.v):p.vt==='num'?Number(p.v):p.vt==='bool'?p.v==='true':p.v)}emit(0,msg)}
 else if(n.type==='mqtt in')emit(0,msg);
 else throw Error('Unexpected effect/node '+n.type+' '+id);
 }
 }
 return {run,flowFor,global,dry,seen,by,setNow(v){now=v}};
}
