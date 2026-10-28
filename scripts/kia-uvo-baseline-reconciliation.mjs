// Root attests a current restored baseline, never the outcome of an old apply.
// There is no installation, restart, vehicle request or receipt mutation here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

export const RECONCILIATION_ROOT='/var/lib/raspberry-kia-promotion-reconciliation';
const hex=(s,n)=>typeof s==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(s);
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':
 '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&canonical(Object.keys(v).sort())===canonical([...keys].sort());
const version=v=>typeof v==='string'&&/^v?\d+\.\d+\.\d+$/.test(v)?v.replace(/^v/,''):null;
export function inventoryBaseline(directory){
 const base=fs.lstatSync(directory);
 if(!base.isDirectory()||base.isSymbolicLink()||fs.realpathSync(directory)!==path.resolve(directory))throw Error('baseline_root_invalid');
 const out={};let total=0,bytes=0,entries=0;
 const visit=(dir,prefix='')=>{
  const before=fs.lstatSync(dir);
  if(!before.isDirectory()||before.isSymbolicLink())throw Error('baseline_directory_invalid');
  for(const name of fs.readdirSync(dir).sort()){
   if(++entries>256||prefix.length>160)throw Error('baseline_inventory_limit');
   if(name==='__pycache__'||name.endsWith('.pyc'))continue;
   if(!/^[A-Za-z0-9_.-]+$/.test(name)||name==='.'||name==='..')throw Error('baseline_name_invalid');
   const p=path.join(dir,name),s=fs.lstatSync(p),rel=prefix+name;
   if(s.isSymbolicLink())throw Error('baseline_symlink');
   if(s.isDirectory()){visit(p,rel+'/');continue;}
   if(!s.isFile()||s.nlink!==1||s.size>262144||++total>128||(bytes+=s.size)>4194304)throw Error('baseline_file_invalid');
   const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   try{const a=fs.fstatSync(fd),raw=fs.readFileSync(fd),b=fs.fstatSync(fd);
    if(!a.isFile()||a.nlink!==1||a.ino!==s.ino||a.dev!==s.dev||raw.length!==a.size||a.size!==s.size||a.mtimeMs!==s.mtimeMs||a.ctimeMs!==s.ctimeMs||a.ino!==b.ino||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs)
     throw Error('baseline_changed');
    out[rel]=sha(raw);
   }finally{fs.closeSync(fd);}
  }
  const after=fs.lstatSync(dir);
  if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('baseline_directory_changed');
 };
 visit(directory);if(!total)throw Error('baseline_empty');return out;
}
export function validateAttestation(v,{previousRaw,candidate,files,hacs,manifestVersion,projectIdentity,now=Date.now()/1000}){
 if(!closed(v,['schema_version','kind','operation_id','issued_at','expires_at','previous_receipt_sha256',
  'previous_source_commit','candidate_commit','target_version','baseline_version','baseline_files',
  'hacs_installed','hacs_installed_commit','project_identity_sha256','historical_outcome','historical_cause_known']))return false;
 let previous;try{previous=JSON.parse(previousRaw);}catch{return false;}
 return v.schema_version===1&&v.kind==='current_baseline_verified_before_different_candidate'
  &&hex(v.project_identity_sha256,64)&&v.project_identity_sha256===projectIdentity
  &&hex(v.operation_id,32)&&hex(v.previous_receipt_sha256,64)&&sha(previousRaw)===v.previous_receipt_sha256
  &&previous?.state==='failed'&&hex(previous.source_commit,40)&&v.previous_source_commit===previous.source_commit
  &&hex(v.candidate_commit,40)&&v.candidate_commit===candidate.commit&&candidate.commit!==previous.source_commit
  &&version(v.target_version)===version(candidate.target)&&version(v.target_version)!==null
  &&version(v.baseline_version)!==null&&version(v.baseline_version)!==version(v.target_version)
  &&Number.isInteger(v.issued_at)&&Number.isInteger(v.expires_at)&&v.issued_at<=now&&now<v.expires_at
  &&v.expires_at-v.issued_at>0&&v.expires_at-v.issued_at<=86400
  &&v.historical_outcome==='unknown_preserved'&&v.historical_cause_known===false
  &&v.hacs_installed===true&&hacs?.installed===true
  &&typeof v.hacs_installed_commit==='string'&&/^[a-f0-9]{7,40}$/.test(v.hacs_installed_commit)
  &&v.hacs_installed_commit===hacs.installed_commit&&version(hacs.version_installed)===v.baseline_version
  &&manifestVersion===v.baseline_version
  &&v.baseline_files&&Object.keys(v.baseline_files).length>0&&canonical(files)===canonical(v.baseline_files)
  &&Object.values(v.baseline_files).every(value=>hex(value,64));
}
function protectedRead(p,maximum){
 const dir=path.dirname(p),d=fs.lstatSync(dir);
 if(fs.realpathSync(dir)!==dir||!d.isDirectory()||d.uid!==0||(d.mode&0o777)!==0o750)throw Error('reconciliation_directory_invalid');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const a=fs.fstatSync(fd);
  if(!a.isFile()||a.uid!==0||a.gid!==d.gid||(a.mode&0o777)!==0o640||a.nlink!==1||a.size>maximum)
   throw Error('reconciliation_file_invalid');
  const raw=fs.readFileSync(fd),b=fs.fstatSync(fd);
  if(raw.length!==a.size||a.ino!==b.ino||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs)
   throw Error('reconciliation_read_changed');
  return raw;
 }finally{fs.closeSync(fd);}
}
export function readProtectedAttestation(){
 const raw=protectedRead(path.join(RECONCILIATION_ROOT,'current.json'),32768),v=JSON.parse(raw);
 if(canonical(v)!==raw.toString('ascii')||!hex(v.previous_receipt_sha256,64))throw Error('reconciliation_invalid');
 return v;
}
function archiveMatches(previousSha){
 const archived=protectedRead(path.join(RECONCILIATION_ROOT,'history',previousSha+'.json'),32768);
 return sha(archived)===previousSha;
}
export function readInstalledHacs(){
 const code="import json; d=json.load(open('/config/.storage/hacs.repositories')).get('data',{}); r=next((v for v in d.values() if isinstance(v,dict) and v.get('full_name')=='Hyundai-Kia-Connect/kia_uvo'),None); print(json.dumps({k:r.get(k) for k in ('installed','installed_commit','version_installed')} if r else None))";
 const r=spawnSync('/usr/bin/docker',['exec','homeassistant','python','-c',code],
  {encoding:'utf8',timeout:8000,maxBuffer:8192,env:{PATH:'/usr/bin:/bin'}});
 if(r.status!==0)throw Error('reconciliation_hacs_unavailable');return JSON.parse(r.stdout);
}
export async function readRuntimeManifest(token,{WebSocketClass,timeoutMs=8000}={}){
 if(typeof token!=='string'||!token.trim())throw Error('reconciliation_manifest_unavailable');
 const WebSocket=WebSocketClass??require('../nodered/node_modules/ws');
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket('ws://127.0.0.1:8123/api/websocket',{handshakeTimeout:timeoutMs,maxPayload:65536});let phase='auth',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);try{ws.terminate();}catch{};error?reject(Error('reconciliation_manifest_unavailable')):resolve(value);};
  const timer=setTimeout(()=>finish(true),timeoutMs);
  ws.on('error',()=>finish(true));ws.on('close',()=>finish(true));
  ws.on('message',(data,isBinary)=>{
   try{
    if(isBinary||data.length>65536)return finish(true);
    const m=JSON.parse(data.toString('utf8'));
    if(m.type==='auth_required'&&phase==='auth'){phase='waiting';ws.send(JSON.stringify({type:'auth',access_token:token}));}
    else if(m.type==='auth_ok'&&phase==='waiting'){phase='manifest';ws.send(JSON.stringify({id:1,type:'manifest/get',integration:'kia_uvo'}));}
    else if(m.type==='result'&&m.id===1&&phase==='manifest')finish(m.success!==true||m.result?.domain!=='kia_uvo'||!version(m.result?.version),version(m.result?.version));
    else if(m.type==='auth_invalid')finish(true);
   }catch{finish(true);}
  });
 });
}
export async function currentBaselineReconciled({repoRoot,previousRaw,candidate,readToken,
 readAttestation=readProtectedAttestation,readHacs=readInstalledHacs,readManifest=readRuntimeManifest,readArchive=archiveMatches,now=Date.now()/1000}){
 try{
  const v=readAttestation();
  // Cheap static rejection before obtaining a token or querying any runtime.
  const projectIdentity=sha(fs.realpathSync(repoRoot));
  if(v.previous_receipt_sha256!==sha(previousRaw)||v.candidate_commit!==candidate.commit||candidate.commit===v.previous_source_commit
    ||v.project_identity_sha256!==projectIdentity||!Number.isInteger(v.issued_at)||!Number.isInteger(v.expires_at)
    ||v.issued_at>now||now>=v.expires_at||v.expires_at-v.issued_at>86400||!readArchive(v.previous_receipt_sha256))return false;
  const files=inventoryBaseline(path.join(repoRoot,'homeassistant/custom_components/kia_uvo'));
  const hacs=readHacs(),manifestVersion=await readManifest(readToken());
  return validateAttestation(v,{previousRaw,candidate,files,hacs,manifestVersion,projectIdentity,now});
 }catch{return false;}
}
