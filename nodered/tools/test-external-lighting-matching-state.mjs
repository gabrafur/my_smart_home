import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./functions/external-lighting-confirmation-message.js',import.meta.url),'utf8');
const now=1800000000000,issued=now-1000;
class Clock extends Date {static now(){return now;}}
const invoke=vm.runInNewContext(`(function(msg,node,flow){${source}\n})`,{Date:Clock,Number,Object});
const roles=['lampada_varanda','lampadas_garagem','refletores_jardim','abajour_sala_de_estar'];

function fixture(states=['on','on','on','on'],at=issued-3600000,expected='on'){
 return {expected_state:expected,external_issued_at:issued,external_operation_id:'synthetic',
  _external_command:{test_mode:true},payload:{observations:Object.fromEntries(roles.map((id,i)=>[id,
   {state:states[i],observed_at:typeof at==='string'?at:new Date(at).toISOString()}]))}};
}
function context(initial){
 const values=new Map(initial?[['external_confirmation_incident_v1__test',initial]]:[]);
 return {values,get:key=>values.get(key),set:(key,value)=>values.set(key,value)};
}
const node={error:()=>assert.fail('unexpected error'),status:()=>{}};
const plain=value=>JSON.parse(JSON.stringify(value));

test('reported regression: all on but older timestamps is silent and unconfirmed',()=>{
 const msg=fixture(),flow=context();const output=invoke(msg,node,flow);
 assert.deepEqual(plain(output),[null,null]);assert.equal(msg.external_confirmation.status,'unconfirmed');
 assert.equal(msg.external_confirmation.matching_reported_states,true);
 assert.ok(msg.external_confirmation.devices.every(d=>d.reason==='stale'));
 const saved=flow.get('external_confirmation_incident_v1__test');
 assert.equal(saved.failed,false);assert.equal(saved.awaiting_fresh_report,true);assert.equal(saved.incident_open,false);
});

test('already off is equally silent and does not claim command confirmation',()=>{
 const msg=fixture(['off','off','off','off'],issued-3600000,'off');
 assert.deepEqual(plain(invoke(msg,node,context())),[null,null]);assert.equal(msg.external_confirmation.status,'unconfirmed');
});

test('missing or future timestamps on matching states never fake confirmation',()=>{
 for(const at of ['not-a-date',now+1]){
  const msg=fixture(undefined,at);assert.deepEqual(plain(invoke(msg,node,context())),[null,null]);
  assert.equal(msg.external_confirmation.status,'unconfirmed');
 }
});

test('partial matching cached states are not blamed for a real mismatching destination',()=>{
 const msg=fixture(['on','off','on','on']);
 msg.payload.observations.lampadas_garagem.observed_at=new Date(now-1).toISOString();
 const [,alert]=invoke(msg,node,context());
 assert.match(alert.alert.message,/garagem: esperado on, encontrado off/);
 for(const label of ['varanda:','jardim:','abajur:'])assert.ok(!alert.alert.message.includes(label));
 assert.ok(!alert.alert.message.includes('alimentação'));assert.equal(alert.payload.recovery,false);
});

test('unknown and unavailable remain inconclusive without a notification or incident',()=>{
 const msg=fixture(['on','unknown','unavailable','on']),flow=context();
 assert.deepEqual(plain(invoke(msg,node,flow)),[null,null]);
 assert.equal(msg.external_confirmation.status,'unconfirmed');
 assert.ok(msg.external_confirmation.devices.some(d=>d.reason==='unavailable'));
 assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,false);
});

test('legacy false alert is not converted into a fabricated recovery',()=>{
 const signature=roles.map(id=>`${id}:stale:on`).join('|');
 const flow=context({version:1,expected:'on',failed:true,signature,issued_at:issued});
 assert.deepEqual(plain(invoke(fixture(),node,flow)),[null,null]);
 const fresh=fixture(undefined,now-1);const output=invoke(fresh,node,flow);
 assert.equal(fresh.external_confirmation.status,'confirmed');
 assert.deepEqual(plain(output),[null,null]);
});

test('genuine prior mismatch stays open until fresh matching observations',()=>{
 const flow=context();invoke(fixture(['on','off','on','on'],now-1),node,flow);
 assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,true);
 assert.deepEqual(plain(invoke(fixture(),node,flow)),[null,null]);
 assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,true);
 const [,recovery]=invoke(fixture(undefined,now-1),node,flow);
 assert.equal(recovery.payload.recovery,true);assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,false);
});

test('newer intention rejects an older completion without replacing its incident',()=>{
 const prior={version:2,expected:'off',failed:true,incident_open:true,issued_at:now,signature:'newer'};
 const flow=context(prior);assert.deepEqual(plain(invoke(fixture(),node,flow)),[null,null]);
 assert.equal(flow.get('external_confirmation_incident_v1__test'),prior);
});

test('same unresolved destination deduplicates as matching peers become fresh',()=>{
 const flow=context(),msg=fixture(['on','off','on','on'],now-1);
 assert.ok(invoke(msg,node,flow)[1]);const again=fixture(['on','off','on','on']);
 again.payload.observations.lampadas_garagem.observed_at=new Date(now-1).toISOString();
 assert.deepEqual(plain(invoke(again,node,flow)),[null,null]);
});

test('test mode never clears a production pending command',()=>{
 const flow=context();flow.set('external_pending_v1',{operation_id:'production'});
 invoke(fixture(undefined,now-1),node,flow);
 assert.deepEqual(flow.get('external_pending_v1'),{operation_id:'production'});
 assert.equal(flow.get('external_pending_v1__test'),null);
});

test('reported abajur unavailable while expected off is silent without claiming success',()=>{
 const msg=fixture(['off','off','off','unavailable'],now-1,'off'),flow=context();
 assert.deepEqual(plain(invoke(msg,node,flow)),[null,null]);
 assert.equal(msg.external_confirmation.status,'unconfirmed');
 assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,false);
});

test('stale opposite states and missing reports do not open an incident',()=>{
 for(const missing of [false,true]){
  const msg=fixture(['on','on','on','off']),flow=context();
  if(missing)delete msg.payload.observations.abajour_sala_de_estar;
  assert.deepEqual(plain(invoke(msg,node,flow)),[null,null]);
  assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,false);
 }
});

test('legacy unavailable notice does not produce a recovery when readings return',()=>{
 const flow=context({version:2,expected:'off',failed:true,incident_open:true,signature:'abajour_sala_de_estar:unavailable:unavailable',issued_at:issued});
 const missing=fixture(['off','off','off','unavailable'],now-1,'off');
 assert.deepEqual(plain(invoke(missing,node,flow)),[null,null]);
 const fresh=fixture(['off','off','off','off'],now-1,'off');
 assert.deepEqual(plain(invoke(fresh,node,flow)),[null,null]);
 assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,false);
});

test('a fresh mismatch remains actionable while unavailable peers are omitted',()=>{
 const flow=context(),msg=fixture(['off','off','off','unavailable'],now-1,'on');
 const [,alert]=invoke(msg,node,flow);
 assert.match(alert.alert.message,/varanda: esperado on, encontrado off/);
 assert.ok(!alert.alert.message.includes('abajur:'));
 assert.ok(!alert.alert.message.includes('unavailable'));
 assert.equal(alert.payload.recovery,false);
});

test('an inconclusive interval neither recovers nor repeats a prior real mismatch',()=>{
 const flow=context(),bad=fixture(['on','off','on','on'],now-1);
 assert.ok(invoke(bad,node,flow)[1]);
 const missing=fixture(['on','unavailable','on','on'],now-1);
 assert.deepEqual(plain(invoke(missing,node,flow)),[null,null]);
 assert.equal(flow.get('external_confirmation_incident_v1__test').incident_open,true);
 assert.deepEqual(plain(invoke(fixture(['on','off','on','on'],now-1),node,flow)),[null,null]);
 assert.equal(invoke(fixture(undefined,now-1),node,flow)[1].payload.recovery,true);
});
