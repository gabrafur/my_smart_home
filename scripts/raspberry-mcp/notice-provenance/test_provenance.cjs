const test=require('node:test'),assert=require('node:assert/strict');
const {NotificationState}=require('../runtime-source/ha-notices/notification_state.cjs');
const n=(id,t='x')=>({notification_id:id,title:t,message:'m',created_at:'2026-11-16T10:00:00+00:00'});
test('collector boundary labels private spool and HA ingress without changing revisions',()=>{
 const s=new NotificationState(),t=Date.parse('2026-11-16T12:00:00Z');
 s.apply({type:'current',notifications:{ha_one:n('ha_one')}},t,t,()=> 'homeassistant.persistent_notification');
 s.apply({type:'added',notifications:{eva_private_x:n('eva_private_x')}},t+1000,t+1000,id=>id==='eva_private_x'?'private_operational_spool':'homeassistant.persistent_notification');
 const rows=[...s.current.values()];
 const priv=rows.find(r=>r.source_provenance?.source==='private_operational_spool');
 const ha=rows.find(r=>r.source_provenance?.source==='homeassistant.persistent_notification');
 assert.ok(priv&&ha);assert.equal(priv.source_provenance.basis,'collector_transport_boundary');
 const plain=new NotificationState();plain.apply({type:'current',notifications:{ha_one:n('ha_one')}},t,t);
 assert.equal([...plain.current.values()][0].revision,ha.revision,'provenance must not change revision');
 assert.equal([...plain.current.values()][0].source_provenance,null,'unknown ingress stays null');
 assert.ok(s.events.every(e=>'source_provenance'in e));
});
test('unknown provenance labels are refused',()=>{
 const s=new NotificationState(),t=Date.parse('2026-11-16T12:00:00Z');
 assert.throws(()=>s.apply({type:'current',notifications:{a:n('a')}},t,t,()=> 'forged'),/invalid_source_provenance/);
});
