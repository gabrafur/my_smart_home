// Worker-owned data-capture fence. It grants no service, upload or policy rights.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const scope='mqtt_metadata_bootstrap_capture_v1';
const need=value=>{if(!value)throw new Error('bootstrap capture fence is unconfirmed');};
const hex=(value,n)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(value);
const canonical=value=>JSON.stringify(value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function readBootstrapInput(file,{privatePolicy=false}={}) {
  need(typeof file==='string'&&path.isAbsolute(file)&&fs.realpathSync(file)===file);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const a=fs.fstatSync(fd);need(a.isFile()&&a.nlink===1&&a.size>0&&a.size<=1048576);
    if(privatePolicy)need(a.uid===process.getuid()&&a.gid===process.getgid()&&(a.mode&0o7777)===0o600);
    const raw=fs.readFileSync(fd),b=fs.fstatSync(fd),named=fs.lstatSync(file);
    need(raw.length===a.size&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&
      a.dev===named.dev&&a.ino===named.ino);return raw;
  }finally{fs.closeSync(fd);}
}
function opened(directory,id,planSha) {
  need(hex(id,32)&&hex(planSha,64)&&typeof directory==='string'&&path.isAbsolute(directory)&&fs.realpathSync(directory)===directory);
  const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  const bound=fs.fstatSync(fd);
  function anchor(){
    const named=fs.lstatSync(directory);
    need(named.isDirectory()&&named.dev===bound.dev&&named.ino===bound.ino&&named.uid===process.getuid()&&
      named.gid===process.getgid()&&(named.mode&0o7777)===0o700);
  }
  try{anchor();}catch(error){fs.closeSync(fd);throw error;}
  return {fd,name:`metadata-bootstrap-${id}.json`,anchor,at:name=>`/proc/self/fd/${fd}/${name}`};
}
function checkedFile(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const a=fs.fstatSync(fd);need(a.isFile()&&a.nlink===1&&a.uid===process.getuid()&&a.gid===process.getgid()&&
      (a.mode&0o7777)===0o600&&a.size>0&&a.size<=65536);
    const raw=fs.readFileSync(fd),b=fs.fstatSync(fd);
    need(raw.length===a.size&&a.ino===b.ino&&a.dev===b.dev&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs);
    const value=JSON.parse(raw);need(canonical(value)===raw.toString());return {raw,value};
  }finally{fs.closeSync(fd);}
}
function checked(value,id,planSha) {
  const keys=['schema_version','scope','operation_id','plan_sha256','phase','target',
    ...(value?.phase==='captured'?['bundle_sha256','checksums_sha256','manifest_sha256']:[])];
  need(value&&Object.keys(value).sort().join()===keys.sort().join()&&value.schema_version===1&&value.scope===scope&&
    value.operation_id===id&&value.plan_sha256===planSha&&['capture_intent','captured'].includes(value.phase)&&
    typeof value.target==='string'&&path.isAbsolute(value.target)&&path.resolve(value.target)===value.target);
  if(value.phase==='captured')need(['bundle_sha256','checksums_sha256','manifest_sha256'].every(key=>hex(value[key],64)));
  return value;
}
function writeNew(file,raw) {
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function beginCapture(directory,id,planSha,target) {
  const ctx=opened(directory,id,planSha);
  try{
    const value=checked({schema_version:1,scope,operation_id:id,plan_sha256:planSha,phase:'capture_intent',target},id,planSha);
    // Existing intent, including one from a lost return, is never overwritten.
    writeNew(ctx.at(ctx.name),canonical(value));ctx.anchor();fs.fsyncSync(ctx.fd);
  }finally{fs.closeSync(ctx.fd);}
}
export function readCapture(directory,id,planSha) {
  const ctx=opened(directory,id,planSha);
  try{const value=checked(checkedFile(ctx.at(ctx.name)).value,id,planSha);ctx.anchor();return value;}
  finally{fs.closeSync(ctx.fd);}
}
export function completeCapture(directory,id,planSha,target) {
  const ctx=opened(directory,id,planSha);let temporary=null;
  try{
    const old=checkedFile(ctx.at(ctx.name)),value=checked(old.value,id,planSha);need(value.target===target);
    const hashes={bundle_sha256:hash(path.join(target,'bundle.json')),checksums_sha256:hash(path.join(target,'checksums.json')),
      manifest_sha256:hash(path.join(target,'manifest.yaml'))};
    if(value.phase==='captured'){
      need(Object.entries(hashes).every(([key,sha])=>value[key]===sha));return value;
    }
    const next={...value,phase:'captured',...hashes};temporary=ctx.name+'.complete-'+crypto.randomBytes(8).toString('hex');
    writeNew(ctx.at(temporary),canonical(next));ctx.anchor();need(checkedFile(ctx.at(ctx.name)).raw.equals(old.raw));
    fs.renameSync(ctx.at(temporary),ctx.at(ctx.name));temporary=null;fs.fsyncSync(ctx.fd);return next;
  }finally{
    if(temporary)fs.unlinkSync(ctx.at(temporary));fs.closeSync(ctx.fd);
  }
}
