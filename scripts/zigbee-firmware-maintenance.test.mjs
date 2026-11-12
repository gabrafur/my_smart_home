import test from 'node:test';
import assert from 'node:assert/strict';
import {newerStable,validFirmwareRequest,firmwareTransaction,decodeVendorResponse} from './zigbee-firmware-maintenance.mjs';
const now=1800000000000;
const request={version:1,id:'a'.repeat(32),requested_at:now,entity_id:'update.synthetic_coordinator',target_version:'20260101',expected_installed_version:'20240101',stable_only:true,source:'daily_updates'};
test('only fresh, strictly scoped stable upgrades are admitted',()=>{
 assert.equal(validFirmwareRequest(request,now),true);
 for(const change of [{target_version:'20230101'},{target_version:'v3.4.5.dev0'},{stable_only:false},{entity_id:'switch.synthetic'},{requested_at:now+1},{requested_at:now-21600001},{command:'anything'}])assert.equal(validFirmwareRequest({...request,...change},now),false);
 assert.equal(newerStable('v3.4.5','v3.4.5.dev0'),true);assert.equal(newerStable('v3.4.4','v3.4.5.dev0'),false);
});
function fixture(){
 const calls=[],job={dispatch_attempted:false,phase:'admitted'},before={state:'on',installed:'20240101',latest:'20260101',in_progress:false};let after=false;
 const ops={save:()=>calls.push('save:'+job.phase),wait:async()=>{},state:async()=>after?{...before,installed:'20260101',state:'off'}:before,
 approveStable:async()=>calls.push('stable'),probe:async()=>calls.push('probe'),backup:async()=>calls.push('backup'),stop:async()=>calls.push('stop'),
 install:async()=>{calls.push('install');after=true},restore:async()=>calls.push('restore'),start:async()=>calls.push('start')};
 return {calls,job,ops,setAfter:v=>{after=v}};
}
test('backup precedes quiesce and firmware; radio restoration and real probe precede success',async()=>{
 const f=fixture(),result=await firmwareTransaction(request,f.ops,f.job);assert.equal(result.status,'updated');
 const events=f.calls.filter(s=>!s.startsWith('save:'));assert.deepEqual(events,['stable','probe','backup','stop','install','restore','start','probe']);
 assert.equal(f.job.phase,'verified');assert.equal(f.job.dispatch_attempted,true);
});
test('failed backup never stops the house or sends firmware',async()=>{
 const f=fixture();f.ops.backup=async()=>{throw Error('backup_failed')};await assert.rejects(firmwareTransaction(request,f.ops,f.job),/backup_failed/);
 assert.equal(f.job.dispatch_attempted,false);assert.ok(!f.calls.includes('stop'));assert.ok(!f.calls.includes('install'));
});
test('uncertain firmware installation is reconciled without repeating it',async()=>{
 const f=fixture();f.ops.install=async()=>{f.calls.push('install');throw Error('response_lost')};
 let reads=0;f.ops.state=async()=>reads++===0?{state:'on',installed:'20240101',latest:'20260101',in_progress:false}:{state:'unavailable',in_progress:true};
 let result=await firmwareTransaction(request,f.ops,f.job);assert.equal(result.status,'pending');assert.ok(!f.calls.includes('start'));
 f.ops.state=async()=>({state:'off',installed:'20260101',latest:'20260101',in_progress:false});
 result=await firmwareTransaction(request,f.ops,f.job);assert.equal(result.status,'updated');assert.equal(f.calls.filter(s=>s==='install').length,1);
});
test('failed radio restoration does not claim success and resumes the service when safe',async()=>{
 const f=fixture();f.ops.restore=async()=>{throw Error('restore_failed')};await assert.rejects(firmwareTransaction(request,f.ops,f.job),/restore_failed/);assert.ok(f.calls.includes('start'));assert.notEqual(f.job.phase,'verified');
});

test('explicit vendor rejection resumes original service without restoring or polling',async()=>{
 const f=fixture();f.ops.install=async()=>{f.calls.push('install');return {accepted:false,dispatched:false}};
 const result=await firmwareTransaction(request,f.ops,f.job);assert.equal(result.status,'failed');assert.equal(f.job.dispatch_attempted,false);assert.ok(f.calls.includes('start'));assert.ok(!f.calls.includes('restore'));
});
test('unsupported restoration implementation blocks firmware before stopping Zigbee',async()=>{
 const f=fixture();f.ops.preflight=async()=>{throw Error('unreviewed_adapter_version')};
 await assert.rejects(firmwareTransaction(request,f.ops,f.job),/unreviewed/);assert.ok(!f.calls.includes('stop'));assert.ok(!f.calls.includes('install'));
});

test('negative SDK acknowledgement without proof of rejection remains uncertain',async()=>{
 const f=fixture();let reads=0;f.ops.state=async()=>reads++===0?{state:'on',installed:'20240101',latest:'20260101',in_progress:false}:{state:'on',installed:'20240101',latest:'20260101',in_progress:null};
 f.ops.install=async()=>{f.calls.push('install');return {accepted:false,dispatched:null}};
 const result=await firmwareTransaction(request,f.ops,f.job);assert.equal(result.status,'pending');assert.equal(f.job.dispatch_attempted,true);assert.ok(!f.calls.includes('start'));assert.ok(!f.calls.includes('restore'));
});

test('known pre-dispatch refusal is distinct from lost acknowledgement or vendor outage',()=>{
 assert.deepEqual(decodeVendorResponse({ok:false,reason:'candidate_changed'},'install',1),{accepted:false,dispatched:false});
 for(const reply of [{ok:false,reason:'vendor_observation_unavailable'},{ok:false,reason:'network_timeout'}])assert.throws(()=>decodeVendorResponse(reply,'install',1));
 assert.throws(()=>decodeVendorResponse({ok:false,reason:'candidate_changed'},'install',1,true));
 assert.deepEqual(decodeVendorResponse({accepted:false,dispatched:null},'install',0),{accepted:false,dispatched:null});
});
