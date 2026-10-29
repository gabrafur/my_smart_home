import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {beginCapture,readCapture,completeCapture}from './offsite-bootstrap-state.mjs';
const id='a'.repeat(32),sha='b'.repeat(64);
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'offsite-bootstrap-fence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('durable capture intent survives a new reader and never permits another target',t=>{
 const root=fixture(t);beginCapture(root,id,sha,path.join(root,'bundle'));
 assert.equal(readCapture(root,id,sha).phase,'capture_intent');
 assert.throws(()=>beginCapture(root,id,sha,path.join(root,'another')));
 assert.throws(()=>readCapture(root,id,'c'.repeat(64)));
 assert.throws(()=>completeCapture(root,id,sha,path.join(root,'another')));
 assert.equal(readCapture(root,id,sha).target,path.join(root,'bundle'));
});
test('completion pins metadata bytes and repetition preserves inode and contents',t=>{
 const root=fixture(t),target=path.join(root,'bundle');fs.mkdirSync(target,{mode:0o700});
 for(const name of ['bundle.json','checksums.json','manifest.yaml'])fs.writeFileSync(path.join(target,name),'SYNTHETIC_'+name,{mode:0o600});
 beginCapture(root,id,sha,target);completeCapture(root,id,sha,target);
 const file=path.join(root,`metadata-bootstrap-${id}.json`),before=fs.readFileSync(file),info=fs.statSync(file);
 completeCapture(root,id,sha,target);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.statSync(file).ino,info.ino);
 fs.writeFileSync(path.join(target,'bundle.json'),'changed');assert.throws(()=>completeCapture(root,id,sha,target));
 assert.deepEqual(fs.readFileSync(file),before);
});
test('unsafe directories, symlinks, hardlinks and non-private fence bytes fail closed',t=>{
 const root=fixture(t);fs.chmodSync(root,0o775);assert.throws(()=>beginCapture(root,id,sha,path.join(root,'bundle')));fs.chmodSync(root,0o700);
 beginCapture(root,id,sha,path.join(root,'bundle'));const file=path.join(root,`metadata-bootstrap-${id}.json`),link=path.join(root,'alias');
 fs.chmodSync(file,0o644);assert.throws(()=>readCapture(root,id,sha));fs.chmodSync(file,0o600);
 fs.linkSync(file,link);assert.throws(()=>readCapture(root,id,sha));fs.unlinkSync(link);
 const original=fs.readFileSync(file);fs.unlinkSync(file);fs.writeFileSync(link,original,{mode:0o600});fs.symlinkSync(link,file);
 assert.throws(()=>readCapture(root,id,sha));
});
test('directory replacement after intent publication is detected before capture can continue',t=>{
 const root=fixture(t),state=path.join(root,'state');fs.mkdirSync(state,{mode:0o700});const original=fs.fsyncSync;let changed=false;
 fs.fsyncSync=fd=>{original(fd);if(!changed&&fs.fstatSync(fd).isFile()){changed=true;fs.renameSync(state,path.join(root,'old-state'));fs.mkdirSync(state,{mode:0o700});}};
 try{assert.throws(()=>beginCapture(state,id,sha,path.join(root,'bundle')));}finally{fs.fsyncSync=original;}
 assert(changed);assert.equal(fs.existsSync(path.join(state,`metadata-bootstrap-${id}.json`)),false);
 assert.equal(fs.existsSync(path.join(root,'old-state',`metadata-bootstrap-${id}.json`)),true);
});
