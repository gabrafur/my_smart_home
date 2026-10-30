import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeStorageRoute, valid} from './runtime-source/storage-maintenance/route.mjs';

test('storage metadata and recoverable cache tests use only synthetic fixtures', () => {
  for (const [directory, pattern] of [
    ['./runtime-source/storage-maintenance/', 'test_*.py'],
    ['./runtime-source/repair-control/', 'test_storage_health_projection.py'],
  ]) {
    const r = spawnSync('python3', ['-I', '-S', '-B', '-m', 'unittest', 'discover',
      '-s', fileURLToPath(new URL(directory, import.meta.url)), '-p', pattern],
    {encoding: 'utf8', timeout: 15000, maxBuffer: 32768});
    assert.equal(r.error, undefined);assert.equal(r.status, 0, r.stdout+r.stderr);
  }
});

test('storage route preserves old tools and separates dry-run from execution', async () => {
  const calls=[];
  const original={name:'admin_action_apply', inputSchema:{type:'object',properties:{action:{const:'migrate_two_notice_aliases'}}},description:'Legacy',annotations:{destructiveHint:true}};
  const prior=async q=>q.method==='tools/list'?{result:{tools:[structuredClone(original),{name:'ha_notifications'},{name:'events_status'}]}}:{legacy:true};
  const route=makeStorageRoute(prior, async p=>{calls.push(p);return {dry_run:true};},
    async(q,_,audit,invoke)=>({result:await invoke()}));
  const legacy={method:'tools/call',params:{name:'admin_action_apply',arguments:{action:'migrate_two_notice_aliases'}}};
  assert.deepEqual(await route(legacy),{legacy:true});assert.equal(calls.length,0);
  const args={host:'raspberry',action:'storage_plan_npm_logs',idempotency_key:'storage-'+'a'.repeat(32)};
  assert.equal((await route({method:'tools/call',params:{name:'admin_action_apply',arguments:args}})).result.dry_run,true);
  const listed=(await route({method:'tools/list'})).result.tools;
  assert.equal(listed.length,3);assert.equal(listed[1].name,'ha_notifications');assert.equal(listed[2].name,'events_status');
  assert.deepEqual(listed[0].inputSchema.oneOf[0],original.inputSchema);assert.equal(listed[0].annotations.destructiveHint,true);
  for(const changed of [{path:'/private'},{host:'other'},{action:'storage_quarantine_backups'},{idempotency_key:'storage-../'}])
    assert.equal(valid('admin_action_apply',{...args,...changed}),false);
});

test('disk_space preserves existing bytes and source clock while adding the bounded real broker view', async () => {
  const original={source:'existing_snapshot', observed_at:'2026-01-01T00:00:00Z', data:{total_bytes:50,available_bytes:10}};
  const prior=async()=>({result:{structuredContent:structuredClone(original),content:[{type:'text',text:JSON.stringify(original)}]}});
  const calls=[];
  const extra={storage_health:{state:'observed'},storage_metadata_refresh:{state:'existing_sample_reused'}};
  const route=makeStorageRoute(prior,async p=>{calls.push(p);return extra;},()=>{throw Error('unexpected write dispatch')});
  const r=await route({method:'tools/call',params:{name:'disk_space',arguments:{host:'raspberry'}}});
  assert.deepEqual(calls,[{name:'storage_metadata_read',arguments:{host:'raspberry'}}]);
  assert.equal(r.result.structuredContent.data.total_bytes,50);assert.equal(r.result.structuredContent.observed_at,original.observed_at);
  assert.deepEqual(r.result.structuredContent.data.storage_health,{state:'observed'});
  assert.deepEqual(JSON.parse(r.result.content[0].text),r.result.structuredContent);
});
