import assert from 'node:assert/strict';
import {harness} from './startup-replay-harness.mjs';
const h=harness(),tab='zigbee_coordinator_recovery_tab',t=Date.UTC(2026,0,1);
await h.run('zg_policy_default',{});
const base={schema_version:1,id:'a'.repeat(32),observed_at:t,running:true,uptime_s:600,device_count:8,maintenance_active:false,blocked_unknown:false,last_good_available:true,last_good_count:8,last_seen_age_s:1,last_snapshot_at:t,last_recovery_at:0,recoveries_24h:0,invalid_param_count:0};
const run=(over,at=t)=>h.run('zg_facts',{payload:{...base,...over,observed_at:at},monitor_now:at,test_mode:true,_msgid:'a'.repeat(16)});
const dry=()=>h.dry.filter(x=>x.id==='zg_dry_run_terminal');
await run({});assert.equal(dry().length,0);
await run({running:false},t+10000);assert.equal(dry().length,0);
await run({running:false},t+70000);assert.equal(dry().at(-1).msg.guard_action,'restart');
await run({running:false},t+71000);assert.equal(dry().filter(x=>x.msg.guard_action==='restart').length,1,'cooldown prevents a restart loop');
await h.run('zg_test_reset',{});
await run({device_count:0},t+1000000);await run({device_count:0},t+1060000);
assert.equal(dry().at(-1).msg.guard_action,'restore');
await h.run('zg_test_reset',{});
await run({last_snapshot_at:0},t+2000000);assert.equal(dry().at(-1).msg.guard_action,'snapshot');
await run({last_snapshot_at:0},t+2000001);assert.equal(dry().filter(x=>x.msg.guard_action==='snapshot').length,1);
for(const over of [{maintenance_active:true},{blocked_unknown:true},{uptime_s:100},{last_seen_age_s:null},{last_seen_age_s:301},{device_count:7}]){
 await h.run('zg_test_reset',{});const before=dry().length;await run({...over,last_snapshot_at:0},t+3000000);assert.equal(dry().length,before,JSON.stringify(over));
}
await h.run('zg_test_reset',{});
await run({running:false,recoveries_24h:2},t+4000000);await run({running:false,recoveries_24h:2},t+4060000);
assert.equal(dry().at(-1).msg.payload.observer_kind,'domain_alert');const count=dry().length;
await run({running:false,recoveries_24h:2},t+4060001);assert.equal(dry().length,count,'blocked incident alerts once');
assert.equal(h.flowFor(tab).get('zg_state_v1','persistent'),undefined,'all replay state is isolated');
assert.ok(!h.seen.includes('zg_write_request'),'full replay never writes the host request');
assert.ok(dry().every(x=>x.msg.simulated===true&&x.msg.dispatched===false));
await h.run('zg_test_reset',{});
await h.run('zg_facts',{payload:{...base,observed_at:t+5000000,last_snapshot_at:t+5000000},monitor_now:t+5000000,test_mode:true,guard_force_snapshot:true,_msgid:'1234567890abcdef'});
assert.equal(dry().at(-1).msg.guard_action,'snapshot','explicit backup uses the same health and final gates');
assert.match(dry().at(-1).msg.guard_request.id,/^[a-f0-9]{32}$/);
// A stale healthy sample can be refused by the host while the mesh stays up.
// Never turn that backup refusal into a claim that the Zigbee network failed.
for(const reason of ['snapshot_not_healthy','maintenance_active']){
 await h.run('zg_test_reset',{});
 const before=dry().length,at=t+6000000;
 await run({last_snapshot_at:at,receipt:{id:'snapshot-refused',action:'snapshot',status:'failed',reason}},at);
 assert.equal(dry().length,before,'expected backup refusal is diagnostic only');
}
await h.run('zg_test_reset',{});
const failedBackup={id:'backup-failed',action:'snapshot',status:'failed',reason:'docker_operation_failed'};
await run({last_snapshot_at:t+7000000,receipt:failedBackup},t+7000000);
assert.equal(dry().at(-1).msg.payload.incident_key,'zigbee_snapshot_failed');
assert.equal(dry().at(-1).msg.alert.title,'Cópia Zigbee não atualizada');
const backupAlerts=dry().length;
await run({last_snapshot_at:t+7000000,receipt:failedBackup},t+7000001);
assert.equal(dry().length,backupAlerts,'unexpected backup failure remains deduplicated');
await h.run('zg_test_reset',{});
await run({running:false,receipt:{id:'backup-refused',action:'snapshot',status:'failed',reason:'snapshot_not_healthy'}},t+8000000);
assert.equal(dry().at(-1).msg.alert.title,'Recuperação Zigbee bloqueada','an actual outage is still reported');
await h.run('zg_test_reset',{});
await run({last_snapshot_at:t+9000000,receipt:{id:'restart-refused',action:'restart',status:'failed',reason:'maintenance_active'}},t+9000000);
assert.equal(dry().at(-1).msg.alert.title,'Tentativa Zigbee bloqueada');
assert.ok(!h.seen.includes('zg_write_request'));
assert.ok(dry().every(x=>x.msg.simulated===true&&x.msg.dispatched===false));
console.log('Zigbee recovery: real canvas confirms failure, restores total loss, preserves last good and bounds requests without household effects.');
