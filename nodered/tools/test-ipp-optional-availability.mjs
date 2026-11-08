import assert from 'node:assert/strict';
import fs from 'node:fs';
const load = name => new Function('msg', 'flow', 'node', fs.readFileSync(new URL(`functions/${name}.js`, import.meta.url), 'utf8'));
const normalize = load('global-flow-observer-integration-normalize');
const lifecycle = load('global-flow-observer-integration-lifecycle');
const reason = 'Invalid response from API: Error occurred while communicating with IPP server.';
const node = {error(message) { throw Error(message); }, status() {}, warn() {}, log() {}};
const runCase = (domain, state, failureReason) => {
  const data = new Map([['global_observer_policy_v1', {version:1,complete:true,status_confirm_seconds:60,reminder_hours:12}]]);
  const flow = {get:key=>data.get(key),set:(key,value)=>data.set(key,value)};
  const run = (now, currentState=state) => lifecycle(normalize({_global_observer_test:true,observer_now:now,config_entries:[{entry_id:'synthetic-printer',domain,state:currentState,reason:failureReason,disabled_by:null}]},flow,node),flow,node);
  assert.equal(run(1_000_000), null);
  const alert = run(1_061_000)[0][0];
  assert.equal(run(1_062_000),null,'dedupe remains active');
  const recovery=run(1_063_000,'loaded')[0][0];
  assert.equal(recovery.payload.persistent_notification_operation,'dismiss');
  assert.equal(recovery.payload.mobile_notification, !(domain === 'ipp' && state === 'setup_retry' && failureReason === reason));
  assert(!JSON.stringify(data).includes(reason));
  return alert;
};
const optional=runCase('ipp','setup_retry',reason);
assert.equal(optional.payload.mobile_notification,false,'expected optional availability never sends push');
assert.equal(optional.payload.availability_reason,'optional_printer_unreachable');
assert.equal(optional.payload.availability_classification,'unknown','transport failure is not proof of power state');
assert.match(optional.alert.title,/Impressora IPP indisponível/);
assert.match(optional.alert.message,/pode estar desligada/);
assert.doesNotMatch(optional.alert.message,/reautenticar|servidor.*falh|quebrad/i);
assert.equal(optional.payload.persistent_notification_operation,'create','diagnosis remains visible');
for (const [domain,state,text] of [['ipp','setup_error',reason],['ipp','migration_error',reason],['ipp','setup_retry','Authentication failed'],['ipp','setup_retry',undefined],['mqtt','setup_retry',reason]]) {
 const result=runCase(domain,state,text);
 assert.equal(result.payload.availability_reason,null);
 assert.equal(result.payload.mobile_notification,true,'real failures retain push');
 assert.match(result.alert.title,/Falha na integração/);
}
console.log('PASS: optional IPP transport diagnosis, failure boundaries, dedupe and recovery');

// Existing generic incident becomes diagnostic once, then deduplicates; a later auth fault alerts.
const data = new Map([['global_observer_policy_v1',{version:1,complete:true,status_confirm_seconds:60,reminder_hours:12}],['global_flow_observer_integrations_v1__test',{version:1,incidents:{printer:{entry_id:'printer',domain:'ipp',first_seen_at:1_000_000,notified_at:1_061_000}}}]]);
const flow={get:k=>data.get(k),set:(k,v)=>data.set(k,v)};
const scan=(now,text)=>lifecycle(normalize({_global_observer_test:true,observer_now:now,config_entries:[{entry_id:'printer',domain:'ipp',state:'setup_retry',reason:text}]},flow,node),flow,node);
const replaced=scan(1_062_000,reason)[0][0];
assert.equal(replaced.payload.mobile_notification,false);
assert.equal(replaced.payload.persistent_notification_operation,'create');
assert.equal(scan(1_063_000,reason),null);
assert.equal(scan(1_064_000,'Authentication failed')[0][0].payload.mobile_notification,true);
console.log('PASS: existing notice reclassification and real-failure transition');
