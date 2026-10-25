import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {diagnosticFunctionSource} from './install-global-diagnostics.mjs';
const raw=fs.readFileSync(new URL('functions/global-flow-observer-diagnostic-build.js',import.meta.url),'utf8').trimEnd();
const body=diagnosticFunctionSource(raw),execute=new Function('msg','fs','crypto','context','Buffer',body);
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'notice-index-synthetic-'));
const map=new Map(),context={get:key=>map.get(key),set:(key,v)=>map.set(key,v)};
const relocate=p=>typeof p==='string'&&p.startsWith('/data')?folder+p.slice(5):p;
const io={};for(const name of ['existsSync','lstatSync','openSync','writeFileSync','fsyncSync','closeSync','fchmodSync','renameSync','unlinkSync'])io[name]=(...args)=>{if(['existsSync','lstatSync','openSync','unlinkSync'].includes(name))args[0]=relocate(args[0]);if(name==='renameSync'){args[0]=relocate(args[0]);args[1]=relocate(args[1]);}const out=fs[name](...args);return name==='lstatSync'?{uid:1000,nlink:out.nlink,mode:out.mode,isFile:()=>out.isFile()}:out;};
function input(test=false,index=0){const err=new Error('operators[rule.t] is not a function; password=synthetic-only');err.name='TypeError';err.source={id:'synthetic_'+index,type:'switch',name:'Synthetic'};return {_global_observer_test:test,error:err,_global_observer:{flow_id:'synthetic',flow_label:'Synthetic'},observer_now:Date.parse('2026-10-25T10:00:00Z')+index*6000};}
try{
 const dry=execute(input(true),{},crypto,context,Buffer);assert(dry._observer_public_diagnostic.simulated);assert(!fs.existsSync(path.join(folder,'.notification-diagnostics.json')));
 for(let i=0;i<35;i++){const result=execute(input(false,i),io,crypto,context,Buffer);assert.equal(result._observer_public_diagnostic.collection_error,undefined);}
 const file=path.join(folder,'.notification-diagnostics.json'),data=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(data.records.length,32);assert(fs.statSync(file).size<=65536);assert(data.records.every(r=>/^[a-f0-9]{64}$/.test(r.notification_id)));assert(!JSON.stringify(data).includes('synthetic-only'));assert(!JSON.stringify(data).includes('Synthetic'));assert(data.records.every(r=>r.error.exception_type==='TypeError'));
 const expected=crypto.createHash('sha256').update('nodered_observabilidade_global_node_error_synthetic_synthetic_34').digest('hex');assert.equal(data.records[0].notification_id,expected);
 console.log('Public notification diagnostics: dry-run, exact ID, atomic write, byte bound, sanitization and retention passed.');
}finally{fs.rmSync(folder,{recursive:true,force:true});}
