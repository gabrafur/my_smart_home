const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {settings, script, sshArgs, repairProxy} = require('./local-ai-proxy-repair');
const fixtureHost = [10, 23, 45, 67].join('.');
const alternatePrivateHost = [10, 23, 45, 68].join('.');
const config = {enabled:true,endpoint:`http://${fixtureHost}:11435`,gpu_probe:{container:'homeassistant',ssh_user:'fixture',ssh_host:fixtureHost,ssh_key_path:'/config/.ssh/fixture',ssh_port:22}};
const opts = () => ({root:fs.mkdtempSync(path.join(os.tmpdir(),'rtx-proxy-test-')),config});
test('fixed endpoint and strict SSH reject command injection or alternate targets',()=>{
 for(const host of ['0.0.0.0','203.0.113.9',alternatePrivateHost,fixtureHost+';whoami']) assert.throws(()=>settings({...config,endpoint:'http://'+host+':11435'}));
 assert.throws(()=>settings({...config,gpu_probe:{...config.gpu_probe,ssh_user:'a;whoami'}}));
 const args=sshArgs(settings(config));assert(args.includes('StrictHostKeyChecking=yes'));assert(args.includes('UserKnownHostsFile=/config/.ssh/known_hosts'));
 const ps=script(fixtureHost);assert(!/Restart-Service|Stop-Service|Start-Service|wsl\.exe|ScheduledTask|Set-NetFirewall|New-NetFirewall/.test(ps));assert(ps.includes('http://${ip}:11435/api/tags'));assert(ps.includes('shared_service_changed'));
});
test('verified result is durable and duplicate operation cannot dispatch twice',async()=>{
 const o=opts();let n=0;o.run=async()=>{n++;return {stdout:JSON.stringify({reason:'ready',effect_attempted:true,services_preserved:true})}};o.fetch=async()=>({ok:true,json:async()=>({models:[]})});
 const first=await repairProxy('operation_success',o);assert.equal(first.outcome,'ready');assert.deepEqual(await repairProxy('operation_success',o),first);assert.equal(n,1);
});
test('timeout blocks further effects across new requests',async()=>{
 const o=opts();let n=0;o.run=async()=>{n++;throw new Error('timeout')};
 assert.equal((await repairProxy('operation_timeout',o)).outcome,'unknown');assert.equal((await repairProxy('operation_another',o)).outcome,'unknown');assert.equal(n,1);
});
test('single-flight excludes parallel requests',async()=>{
 const o=opts();let finish;o.run=()=>new Promise(resolve=>{finish=resolve});const first=repairProxy('operation_first',o);
 assert.equal((await repairProxy('operation_second',o)).outcome,'unknown');finish({stdout:'{"reason":"backend_not_ready","effect_attempted":false}'});assert.equal((await first).outcome,'failed');
});
test('remote ready without client proof is not recovery',async()=>{
 const o=opts();o.run=async()=>({stdout:'{"reason":"ready","effect_attempted":false}'});o.fetch=async()=>{throw new Error('unreachable')};assert.equal((await repairProxy('operation_unverified',o)).reason,'bridge_path_unreachable');
});
test('invalid request never runs and malformed results stay blocked',async()=>{
 const o=opts();o.run=async()=>({stdout:'private unexpected content'});assert.equal((await repairProxy('../bad',o)).outcome,'rejected');assert.equal((await repairProxy('operation_bad_output',o)).outcome,'unknown');
});
