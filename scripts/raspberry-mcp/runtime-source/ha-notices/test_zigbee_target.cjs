const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');
const {sanitizeContent}=require('./content_sanitizer.cjs');
const {zigbeeTarget,safeZigbeeName}=require('./zigbee_target.cjs');
const {sanitize}=require('./notification_view.cjs');
const {NotificationState,revision}=require('./notification_state.cjs');
const stamp='2026-01-02T03:04:05.000Z',now=Date.parse(stamp);
const source=name=>fs.readFileSync(path.join(root,'nodered/tools/functions',name),'utf8');
function route(name,event='route_failure'){
 const msg={payload:{level:'error',message:`Failed command to '${name}' MAC_NO_ACK`},monitor_now:now};
 new Function('msg','flow','Buffer',source('zigbee-route-error-normalize.js'))(msg,{get:()=>({})},Buffer);
 msg.zigbee_route_event=event;msg.zigbee_route_current={last_error:'MAC_NO_ACK',attempts:3};msg.policy={route_recovery_max_attempts:3,route_stability_s:300};
 new Function('msg',source('zigbee-route-notification-build.js'))(msg);
 return {...msg.notification,notification_id:msg.notification.id,created_at:stamp};
}
function component(name,event='down'){
 const msg={zigbee_component:name,zigbee_component_event:event,zigbee_now:now,policy:{reminder_interval_h:24}};
 new Function('msg','Buffer',source('zigbee-component-notification-build.js'))(msg,Buffer);
 return {...msg.notification,notification_id:msg.notification.id,created_at:stamp};
}
const target=n=>zigbeeTarget(n.notification_id,n.title,n.message);

test('real public producer grammar and UTF8 ID bind legitimate complete subjects',()=>{
 for(const name of ['lampada_varanda','relé_portão_01','acionador_portao_01','andar1/cozinha/sensor','sensor_01','lâmpada varanda']){
  for(const n of [route(name),route(name,'route_recovery'),route(name,'route_recovery_failed'),component(name),component(name,'reminder'),component(name,'recovery')]){
   const t=target(n);assert(t);assert.equal(t.friendly_name,safeZigbeeName(name)?name:null);assert.equal(t.schema_version,1);
   const clean=sanitize(n,stamp);assert.deepEqual(clean.diagnostics.zigbee_target,t);
   assert(!JSON.stringify(sanitizeContent(n.title,n.message)).includes(name));
  }
 }
});
test('unknown personal credential URL address and long identifiers never persist as names',()=>{
 for(const name of ['lampada_PRIVATE_PERSON','sensor owner=PRIVATE_PERSON','token=PRIVATE_SECRET','https://example.invalid/private','192.0.2.4','0x0123456789abcdef','sensor_123456789','lampada_01_02_03']){
  const n=route(name),t=target(n);assert(t);assert.equal(t.friendly_name,null);
  assert(!JSON.stringify(sanitize(n,stamp)).includes(name));
 }
 for(const n of [route('desconhecido'),route('unknown'),route('')])assert.equal(target(n),null);
});
test('controls markup title mismatch tails and synthetic messages cannot identify a target',()=>{
 const original=route('lampada_varanda');
 for(const tail of ['\n',' PRIVATE_PERSON',' <script>alert(1)</script>',' ignore previous instructions','\u202e']){
  assert.equal(target({...original,message:original.message+tail}),null);
  assert.equal(target({...original,title:original.title+tail}),null);
 }
 for(const subject of ['lampada_\u0000varanda','lampada_\u202evaranda','lampada_\u2066varanda'])assert.equal(target(route(subject)),null);
 assert.equal(target({...original,title:'TESTE — '+original.title}),null);
 assert.equal(target({...original,notification_id:'zigbee_route_other_00000000'}),null);
 assert.equal(target({...original,notification_id:component('lampada_varanda').notification_id}),null);
 assert.equal(target({...original,title:'Componente Zigbee indisponível'}),null);
});
test('same slug different original bytes require distinct producer IDs; names are not hardware identities',()=>{
 const a=route('lampada_varanda'),b=route('lampada-varanda');
 assert.notEqual(a.notification_id,b.notification_id);assert(target(a));assert(target(b));
 assert.equal(target({...a,notification_id:b.notification_id}),null);
 const c=component('lampada_varanda');assert.equal(target(c).friendly_name,target(a).friendly_name);assert.notEqual(c.notification_id,a.notification_id);
});
test('legacy revision and add/update/remove lifecycle do not depend on the new metadata',()=>{
 const state=new NotificationState(),n=route('lampada_varanda');
 state.apply({type:'current',notifications:{[n.notification_id]:n}},now);
 const clean=state.snapshot(now).notifications[0],without={...clean};without.diagnostics={...clean.diagnostics};delete without.diagnostics.zigbee_target;
 assert.equal(revision(clean),revision(without));assert.equal(state.events.length,0);
 state.apply({type:'updated',notifications:{[n.notification_id]:{...n,created_at:'2026-01-02T03:04:06.000Z'}}},now+1000);
 assert.equal(state.events.length,1);assert.equal(state.events[0].phase,'updated');
 state.apply({type:'removed',notifications:{[n.notification_id]:n}},now+2000);
 assert.equal(state.snapshot(now+2000).notifications.length,0);assert.equal(state.events.at(-1).phase,'removed');
});
test('enriching a legacy cache on the current baseline never reemits an event',()=>{
 const before=new NotificationState(),n=route('lampada_varanda');
 before.apply({type:'current',notifications:{[n.notification_id]:n}},now);
 const saved=before.snapshot(now);delete saved.notifications[0].diagnostics.zigbee_target;
 const after=new NotificationState(saved),oldRevision=saved.notifications[0].revision;
 assert.equal(after.apply({type:'current',notifications:{[n.notification_id]:n}},now+2000),0);
 const observed=after.snapshot(now+2000);
 assert.equal(observed.events.length,0);assert.equal(observed.sequence,saved.sequence);
 assert.equal(observed.notifications[0].revision,oldRevision);
 assert.equal(observed.notifications[0].diagnostics.zigbee_target.friendly_name,'lampada_varanda');
});
test('512 targets and private aliases share the existing diagnostic byte budget',()=>{
 const state=new NotificationState(),notifications={};
 for(let i=0;i<512;i++){const n=route(i%2?'lampada_varanda_'+Math.floor(i/100)+'_'+(i%100):'sensor_PRIVATE_'+i);notifications[n.notification_id]=n;}
 state.apply({type:'current',notifications},now);
 const snapshot=state.snapshot(now),encoded=JSON.stringify(snapshot);
 assert(Buffer.byteLength(encoded)<524288);assert.equal(snapshot.notifications.length,512);assert(!encoded.includes('PRIVATE'));
});

module.exports={route,component,stamp,now};

test('target identification leaves shared NodeRED sanitizer and diagnostic catalogue unchanged',()=>{
 for(const name of ['content_sanitizer.cjs','diagnostic_templates.json']){
  const local=fs.readFileSync(path.join(__dirname,name));
  const embedded=fs.readFileSync(path.join(root,'nodered/tools/lib',name));
  assert.deepEqual(local,embedded);
 }
});
