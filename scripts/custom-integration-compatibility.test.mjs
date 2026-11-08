import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCustomIntegrationCompatibility as check} from './custom-integration-compatibility.mjs';
const target=[{service:'homeassistant',image:'ghcr.io/home-assistant/home-assistant@sha256:'+'a'.repeat(64)}];
const accepted={state:'compatible',network_enabled:false,production_configuration_mounted:false,apple_authentication_called:false};
function options(run){return {repoRoot:'/synthetic/repo',run};}
test('other service requires no probe',()=>assert.equal(check([{service:'mosquitto'}],options(()=>assert.fail())).state,'not_required'));
test('unpinned candidate rejected before any process',()=>assert.throws(()=>check([{service:'homeassistant',image:'mutable:latest'}],options(()=>assert.fail())),/identity unconfirmed/));
test('dry run is explicit unknown and creates no container',()=>assert.equal(check(target,{...options(()=>assert.fail()),dryRun:true}).state,'not_checked'));
test('candidate probe has no production mounts, network or credentials',()=>{
 const result=check(target,options((command,args,opts)=>{
  assert.equal(command,'docker');assert(args.includes('--pull=never'));assert.equal(args[args.indexOf('--network')+1],'none');assert(args.includes('--read-only'));assert(args.includes('no-new-privileges'));assert.equal(opts.timeout,110000);
  const mounts=args.filter((_,i)=>args[i-1]==='--mount');assert.equal(mounts.length,2);assert(mounts.every(m=>m.endsWith(',readonly')&&!m.includes('.storage')&&!m.includes('/config')));assert.equal(args.filter(x=>x===target[0].image).length,1);return JSON.stringify(accepted);
 }));assert.equal(result.state,'compatible');
});
test('constructor or version failure closes gate',()=>assert.throws(()=>check(target,options(()=>{throw Error('private sentinel');})),/compatibility unconfirmed/));
test('invalid, missing and refused evidence stays blocked',()=>{for(const result of ['invalid',{},null,{...accepted,state:'blocked'},{...accepted,network_enabled:true},{...accepted,production_configuration_mounted:true}])assert.throws(()=>check(target,options(()=>typeof result==='string'?result:JSON.stringify(result))),/compatibility/);});

test('failed probe exposes only reviewed reason without private stderr',()=>{
 const error=Object.assign(new Error('private sentinel'),{stdout:JSON.stringify({state:'blocked',reason:'unsupported_icloud_core_version'}),stderr:'private sentinel'});
 assert.throws(()=>check(target,options(()=>{throw error;})),e=>e.message.endsWith('reason=unsupported_icloud_core_version')&&!e.message.includes('private sentinel'));
});
test('unknown and oversized output stays sanitized',()=>{
 for(const stdout of ['private sentinel',JSON.stringify({state:'blocked',reason:'private sentinel'}),'x'.repeat(4097)]) assert.throws(()=>check(target,options(()=>{throw Object.assign(Error('private sentinel'),{stdout});})),e=>e.message.endsWith('reason=compatibility_unconfirmed')&&!e.message.includes('private sentinel'));
});
test('timeout is distinct and never retries',()=>{
 let calls=0;assert.throws(()=>check(target,options(()=>{calls++;throw Object.assign(Error('private sentinel'),{code:'ETIMEDOUT'});})),/reason=compatibility_probe_timeout$/);assert.equal(calls,1);
});
test('blocked result preserves reviewed reason',()=>assert.throws(()=>check(target,options(()=>JSON.stringify({state:'blocked',reason:'icloud_constructor_changed'}))),/reason=icloud_constructor_changed$/));
