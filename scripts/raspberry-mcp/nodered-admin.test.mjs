import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const candidate=fileURLToPath(new URL('./nodered-admin-candidate/',import.meta.url));
function run(command,args,cwd=repo){
 const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:8*1048576,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(r.error,undefined);assert.equal(r.status,0,(r.stderr||r.stdout).slice(-16000));return r.stdout;
}
test('closed engine, native coordinator and transport synthetic contracts',()=>{
 run('python3',['-B','-m','unittest','discover','-s',candidate,'-p','test_*.py']);
});
test('new MCP parser preserves legacy framing and rejects forged authority',()=>{
 run(process.execPath,['--test','--test-concurrency=1',path.join(candidate,'frontend/test-nodered-admin.mjs')]);
});
test('canonical lighting validates only in an isolated public fixture',()=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'nodered-admin-review-'));
 try{
  const files=run('git',['ls-files','nodered/tools','nodered/package.json','nodered/flows.json','docs/ILUMINACAO_EXTERNA_NODERED.md']).trim().split('\n');
  assert(files.length>0&&files.length<8192);let total=0;
  for(const file of files){
   assert(/^(nodered\/|docs\/ILUMINACAO_EXTERNA_NODERED\.md$)/.test(file)&&!file.includes('..'));
   const body=run('git',['show',':'+file]);total+=Buffer.byteLength(body);assert(total<32*1048576);
   const dest=path.join(fixture,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,body);
  }
  // The review patch supports an older baseline; promoted canonical sources
  // already contain the regression and must never receive it a second time.
  if(!fs.existsSync(path.join(fixture,'nodered/tools/test-external-lighting-confirmation-lifecycle.mjs')))
   run('git',['apply',path.join(candidate,'lighting.patch')],fixture);
  const tools=path.join(fixture,'nodered/tools');
  for(const file of ['install-external-lighting-visual-policy.mjs','install-global-flow-observer.mjs','apply-left-margin.mjs'])
   run(process.execPath,[path.join(tools,file)],fixture);
  run(process.execPath,['--test','--test-concurrency=1',...['test-external-lighting-confirmation-lifecycle.mjs','test-external-lighting-matching-state.mjs','test-external-lighting-alarm-flow.mjs'].map(n=>path.join(tools,n))],fixture);
  for(const file of ['validate-flow-layout.mjs','validate-manual-test-policy.mjs','validate-global-flow-observer.mjs'])
   run(process.execPath,[path.join(tools,file)],fixture);
  const before=JSON.parse(run('git',['show',':nodered/flows.json']));
  const after=JSON.parse(fs.readFileSync(path.join(fixture,'nodered/flows.json'),'utf8'));
  const selected=n=>n.id==='ce258dec9814b96b'||n.z==='ce258dec9814b96b';
  assert.deepEqual(after.filter(n=>!selected(n)),before.filter(n=>!selected(n)));
 }finally{fs.rmSync(fixture,{recursive:true,force:true});}
});
