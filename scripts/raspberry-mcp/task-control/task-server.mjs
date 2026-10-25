import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {makeAdminRoute} from './admin-server.mjs';
import {makeControlRoute} from './codex-control-server.mjs';
import {makeEventRoute} from './events-server.mjs';
import {makeRoute} from './notices-server.mjs';
import {route as legacy} from './durable-server.mjs';
import {route as toolRoute,brokerCall} from './expanded-server.mjs';

import {descriptors} from './task-tools.mjs';
export {descriptors};
export function makeTaskRoute(prior,invoke=brokerCall,audit=()=>{}){return async q=>{
 if(q?.method==='tools/call'&&descriptors.some(t=>t.name===q.params?.name))
  return toolRoute({...q,params:{...q.params,name:'project_files'}},undefined,row=>audit({...row,tool:q.params.name}),()=>invoke(q.params));
 const r=await prior(q);
 if(q?.method==='tools/list'&&r?.result?.tools)r.result.tools.push(...structuredClone(descriptors));
 return r;
};}
export function makeFullRoute(invoke=brokerCall,audit=()=>{}){
 return makeTaskRoute(makeAdminRoute(makeControlRoute(makeEventRoute(makeRoute(legacy,toolRoute,invoke,audit)),invoke),invoke),invoke,audit);
}
async function serve(){
 const audit=row=>fs.writeSync(2,JSON.stringify(row)+'\n');
 const route=makeFullRoute(brokerCall,audit);
 let pending=Buffer.alloc(0),count=0,start=Date.now();
 for await(const chunk of process.stdin){for(const byte of chunk){
  if(pending.length>=16384)return;
  pending=Buffer.concat([pending,Buffer.from([byte])]);
  if(byte!==10)continue;
  if(Date.now()-start>=60000){start=Date.now();count=0;}
  if(++count>60)return;
  let q;try{q=JSON.parse(pending.toString())}catch{q=null}
  pending=Buffer.alloc(0);const r=await route(q);
  if(r&&!process.stdout.write(JSON.stringify(r)+'\n'))await new Promise(resolve=>process.stdout.once('drain',resolve));
 }}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 serve().catch(()=>{process.exitCode=1;});
