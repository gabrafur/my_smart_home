import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { call, project, TOOLS } from './raspberry-mcp/core.mjs';
import { dispatch } from './raspberry-mcp/server.mjs';
import { collect, backupResult, logSummary } from './raspberry-mcp/collect.mjs';
const fixture = { observed_at: '2026-01-01T00:00:00Z', services: [{service:'homeassistant',state:'running',health:'healthy',version:'2026.1.0'}], disk:{total_bytes:1000,available_bytes:500}, backups:{git:{status:'success',finished_at:'2026-01-01T00:00:00Z'}} };
const request = (name, args = {host:'raspberry'}) => ({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
test('all tools discoverable and read-only; initialize and ping', () => {
  const invoke = r => dispatch(r, () => fixture, () => {});
  const list = invoke({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools;
  assert.deepEqual(list.map(x=>x.name),TOOLS);
  assert.ok(list.every(x=>x.annotations.readOnlyHint && !x.annotations.openWorldHint && !x.inputSchema.additionalProperties));
  assert.equal(invoke({jsonrpc:'2.0',id:'init_1',method:'initialize',params:{protocolVersion:'2025-06-18'}}).result.protocolVersion,'2025-06-18');
  assert.deepEqual(invoke({jsonrpc:'2.0',id:2,method:'ping'}).result,{});
  assert.equal(invoke({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  for (const tool of TOOLS) assert.ok(invoke(request(tool, {host:'raspberry',...(tool === 'log_summary' ? {service:'nodered'} : {})})).result);
});
test('malicious and unauthorized input rejected before source access', () => {
  const cases = [request('exec'),request('disk_space',{host:'other_pc'}),request('disk_space',{host:'raspberry',path:'/etc/shadow'}),request('disk_space',{host:'raspberry',url:'http://example.invalid'}),request('disk_space',{host:'raspberry',command:'$(id)'}),request('log_summary',{host:'raspberry',service:'nodered;id'}),request('log_summary',{host:'raspberry',service:'../secret'}),request('disk_space',null),request('disk_space',[]),request('disk_space',{host:'raspberry',extra:true})];
  for (const r of cases) {
    let reads=0; const rows=[];
    const result=dispatch(r,()=>{reads++;return fixture;},x=>rows.push(x));
    assert.equal(reads,0); assert.equal(result.error.message,'invalid_parameters');
    assert.equal(rows.length,1); assert.equal(rows[0].outcome,'rejected');
    assert.ok(!JSON.stringify(rows).includes('command'));
  }
});
test('projection drops secrets, raw logs, metadata and unsafe versions', () => {
  const s=project({...fixture,private_metadata:'SYNTHETIC_PRIVATE',calendar:['SYNTHETIC_PRIVATE'],services:[{service:'nodered',state:'SYNTHETIC_PRIVATE',version:'SYNTHETIC_PRIVATE'}],logs:[{service:'nodered',status:'sampled',text:'SYNTHETIC_PRIVATE',error_lines:-1}]});
  assert.ok(!JSON.stringify(s).includes('SYNTHETIC_PRIVATE'));
  assert.equal(s.services[1].version,null);assert.equal(s.logs[1].error_lines,null);
  assert.deepEqual(call({name:'disk_space',arguments:{host:'raspberry'}},fixture).data,fixture.disk);
});
test('errors and audit never contain source or exception text; audit fails closed', () => {
  const rows=[]; const response=dispatch(request('disk_space'),()=>{throw Error('SYNTHETIC_PRIVATE');},row=>rows.push(row));
  assert.equal(response.error.message,'snapshot_unavailable');
  assert.ok(!JSON.stringify([response,rows]).includes('SYNTHETIC_PRIVATE'));
  assert.throws(()=>dispatch(request('disk_space'),()=>fixture,()=>{throw Error('audit unavailable');}));
});
test('collector uses only fixed allowlist and reports partial failure honestly', () => {
  const calls=[];
  const s=collect(args=>{calls.push(args);if(args[0]==='logs')return 'ERROR SYNTHETIC_PRIVATE\nWARN calendar private';return '"running"|"healthy"|"image:1.2.3"';},()=> 'status=success\nfinished_at=2026-01-01T00:00:00Z\nrequest_id=SYNTHETIC_PRIVATE',()=>fixture.disk);
  assert.equal(calls.length,6);assert.ok(calls.every(x=>['homeassistant','nodered','mosquitto'].includes(x.at(-1))));
  assert.ok(!JSON.stringify(s).includes('SYNTHETIC_PRIVATE'));assert.equal(s.logs[0].error_lines,1);
  assert.equal(s.backups.git.status,'success');assert.equal(s.backups.offsite.status,'unknown');
  const failed=collect(()=>{throw Error('private');},()=>{throw Error('private');},()=>{throw Error('private');});
  assert.equal(failed.services[0].state,'unknown');assert.equal(failed.logs[0].status,'unavailable');assert.equal(failed.disk.total_bytes,null);
  assert.equal(logSummary('nodered','error\n'.repeat(200)).sampled_lines,100);
  assert.equal(backupResult('status=failed').status,'failed');
});
test('stdio lifecycle, invalid JSON, size and rate limits with no residential data', () => {
  const run = input => spawnSync(process.execPath,['scripts/raspberry-mcp/server.mjs'],{input,encoding:'utf8',timeout:2000,maxBuffer:65536});
  const r=run('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).result.tools.length,5);
  assert.equal(JSON.parse(run('broken\n').stdout).error.message,'invalid_request');
  const oversized=run('x'.repeat(16385)+'\n');assert.equal(oversized.stdout,'');assert.match(oversized.stderr,/oversize/);
  const limited=run(('{"jsonrpc":"2.0","id":1,"method":"ping"}\n').repeat(61));assert.equal(limited.stdout.trim().split('\n').length,60);assert.match(limited.stderr,/rate_limited/);
});
