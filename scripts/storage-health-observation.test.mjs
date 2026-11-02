import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
for(const args of [['--apply'],['--dry-run'],['--deep','--apply']])test('legacy health '+args.join(' ')+' preserves protected backup and log bytes',()=>{
 const t=fs.mkdtempSync(path.join(os.tmpdir(),'storage-observation-'));try{
 const data=path.join(t,'data'),bin=path.join(t,'bin');fs.mkdirSync(bin);const files=[];
 for(const relative of ['backups/codex-flows/old-flow.json','.npm/_logs/old-debug.log','context/persistent.json','flows_cred.json']){const p=path.join(data,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'protected canary');const old=new Date(Date.now()-90*86400000);fs.utimesSync(p,old,old);files.push(p);}
 fs.writeFileSync(path.join(bin,'wc'),'#!/bin/sh\nexit 42\n',{mode:0o755});
 const r=spawnSync(path.join(here,'storage-health-maintenance.sh'),args,{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,STORAGE_MAINTENANCE_DATA_ROOT:data,STORAGE_MAINTENANCE_LOCK_DIR:path.join(t,'lock')}});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/mode=dry-run/);assert.match(r.stdout,/cleanup_enabled=false/);assert.match(r.stdout,/removed_count=0\|removed_bytes=0/);assert.match(r.stdout,/candidate_count=2\|/);assert.ok(!r.stdout.includes(data));for(const p of files)assert.equal(fs.readFileSync(p,'utf8'),'protected canary');assert.ok(!fs.existsSync(path.join(t,'lock')));
 }finally{fs.rmSync(t,{recursive:true,force:true});}
});
test('host health request invokes only the report category and consumes its request once',()=>{
 const t=fs.mkdtempSync(path.join(os.tmpdir(),'storage-observation-request-'));try{const dir=path.join(t,'trigger'),calls=path.join(t,'calls'),script=path.join(t,'metadata.sh');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'manual-trigger'),'');fs.writeFileSync(script,'#!/bin/sh\nprintf "%s\\n" "$*" >> "'+calls+'"\n',{mode:0o755});const env={...process.env,STORAGE_MAINTENANCE_TRIGGER_DIR:dir,STORAGE_MAINTENANCE_SCRIPT:script};for(let i=0;i<2;i++){const r=spawnSync(path.join(here,'process-storage-maintenance-request.sh'),[],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);}assert.equal(fs.readFileSync(calls,'utf8'),'--apply --category report\n');assert.deepEqual(fs.readdirSync(dir),[]);
 }finally{fs.rmSync(t,{recursive:true,force:true});}
});
