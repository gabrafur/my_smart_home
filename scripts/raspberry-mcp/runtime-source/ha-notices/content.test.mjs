import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
test('isolated notification sanitizer and MCP route regressions',()=>{const r=spawnSync(process.execPath,['--test','--test-concurrency=1',fileURLToPath(new URL('test_content.cjs',import.meta.url)),fileURLToPath(new URL('test_frontend.mjs',import.meta.url))],{encoding:'utf8',timeout:15000,maxBuffer:32768});assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.error,undefined);});

import fs from 'node:fs';test('Node-RED embeds the exact reviewed public sanitizer and catalog',()=>{for(const name of ['content_sanitizer.cjs','diagnostic_templates.json'])assert.equal(fs.readFileSync(new URL(name,import.meta.url),'utf8'),fs.readFileSync(new URL('../../../../nodered/tools/lib/'+name,import.meta.url),'utf8'));});

import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {sanitizeContent}=require('./content_sanitizer.cjs');
const radioBody=(domain='Radio Browser',state='setup_retry',age='2')=>
 `A integração ${domain} permanece em ${state} há ${age} min. `+
 'Abra Configurações → Dispositivos e serviços no Home Assistant '+
 'para consultar ou reautenticar a entrada.';

test('exact public Radio Browser notice pair preserves setup_retry without an authentication claim',()=>{
 const producer=fs.readFileSync(new URL('../../../../nodered/tools/functions/global-flow-observer-integration-lifecycle.js',import.meta.url),'utf8');
 assert(producer.includes('Falha na integração ${domainLabel(entry.domain)}'));
 assert(producer.includes('Falha persiste na integração ${domainLabel(entry.domain)}'));
 assert(producer.includes('A integração ${domainLabel(entry.domain)} permanece em '));
 assert(producer.includes('para consultar ou reautenticar a entrada.'));
 for(const title of ['Falha na integração Radio Browser','Falha persiste na integração Radio Browser','TESTE — Falha na integração Radio Browser']){
  for(const age of ['2','1.234']){
   const result=sanitizeContent(title,radioBody('Radio Browser','setup_retry',age));
   assert.deepEqual(result.title_codes,['integration_failure','radio_browser']);
   assert.deepEqual(result.message_codes,['radio_browser','setup_retry']);
   assert.deepEqual(result.integration_codes,['radio_browser']);
   assert.deepEqual(result.reason_codes,['setup_retry']);
   assert.equal(result.guidance_code,'check_integration');
   assert.deepEqual(result.error.reason_codes,[]);
   assert(!JSON.stringify(result).includes(age+' min'));
  }
 }
});

test('paired Radio Browser template tails cannot export private text or extra diagnostic claims',()=>{
 const tails=[' nome=PRIVATE_PERSON',' https://private.example.invalid/path',
  ' token=PRIVATE_TOKEN',' config_entry_PRIVATE_IDENTIFIER',' authentication failed'];
 for(const tail of tails){
  const result=sanitizeContent('Falha na integração Radio Browser'+tail,radioBody()+tail);
  const encoded=JSON.stringify(result);
  assert.deepEqual(result.reason_codes,['setup_retry']);
  assert.equal(result.guidance_code,'check_integration');
  assert(result.redacted_fields.some(item=>item.reason==='non_allowlisted_text_may_contain_personal_data'));
  for(const withheld of ['PRIVATE_PERSON','private.example.invalid','PRIVATE_TOKEN','PRIVATE_IDENTIFIER','authentication failed'])assert(!encoded.includes(withheld));
  assert.deepEqual(result.error.reason_codes,[]);
 }
});

test('unknown domains and unpaired or altered templates remain withheld',()=>{
 for(const domain of ['Private Domain','Radio BrowserPrivate','Radio Browser Private','radio_browser']){
  const result=sanitizeContent('Falha na integração '+domain,radioBody(domain));
  assert(!result.integration_codes.includes('radio_browser'));
  assert(!result.reason_codes.includes('setup_retry'));
  assert(!JSON.stringify(result).includes(domain));
 }
 for(const [title,message]of [['aviso',radioBody()],['Radio Browser','setup_retry'],
  ['Falha na integração Radio Browser',radioBody('Radio Browser','private_state')]]){
  const result=sanitizeContent(title,message);
  assert(!result.reason_codes.includes('setup_retry'));
  assert(!result.integration_codes.includes('radio_browser'));
  assert(!JSON.stringify(result).includes('private_state'));
 }
 const generic=sanitizeContent('aviso','Abra Configurações → Dispositivos e serviços no Home Assistant para consultar ou reautenticar a entrada.');
 assert(!generic.reason_codes.includes('authentication'));
 assert.equal(generic.guidance_code,'check_integration');
});

// These producers only construct messages; the replay never calls a service/MQTT.
const {NotificationState}=require('./notification_state.cjs');
const {createHash}=require('node:crypto');
const zigbeeClock=Date.UTC(2026,9,30,22,5,0);
const producer=(name,msg)=>new Function('msg',fs.readFileSync(new URL('../../../../nodered/tools/functions/'+name,import.meta.url),'utf8'))(structuredClone(msg)).notification;
const routeNotice=(event='route_failure',code='MAC_NO_ACK',maximum=3,attempts=1)=>producer('zigbee-route-notification-build.js',{
 zigbee_route_event:event,zigbee_route_device:'PRIVATE_ROUTER_ALPHA',zigbee_route_key:'synthetic_key',zigbee_route_now:zigbeeClock,
 zigbee_route_current:{last_error:code,attempts},policy:{route_recovery_max_attempts:maximum,route_recovery_cooldown_min:15,route_stability_s:300}});
const componentNotice=event=>producer('zigbee-component-notification-build.js',{
 zigbee_component_event:event,zigbee_component:'PRIVATE_COMPONENT_BETA',zigbee_component_key:'synthetic_key',zigbee_now:zigbeeClock,policy:{reminder_interval_h:24}});
const networkNotice=event=>producer('zigbee-network-notification-build.js',{
 zigbee_event:event,zigbee_now:zigbeeClock,policy:{reminder_interval_h:24,recovery_confirmation_s:60}});
const cleanNotice=notice=>sanitizeContent(notice.title,notice.message);

test('exact live Zigbee producers export reviewed route codes and bounded attempts without names or clocks',()=>{
 for(const code of ['MAC_NO_ACK','NWK_NO_ROUTE','MAC_NO_CHANNEL_ACCESS'])for(let total=1;total<=5;total++){
  const notice=routeNotice('route_failure',code,total),out=cleanNotice(notice),encoded=JSON.stringify(out);
  assert.deepEqual(out.integration_codes,['zigbee']);assert.deepEqual(out.reason_codes,[code]);
  assert(out.message_codes.includes('zigbee_route_failure'));assert(out.message_codes.includes('zigbee_attempt_1_of_'+total));
  assert.equal(out.schema_version,1);assert.equal(out.guidance_code,'check_integration');assert.equal(out.raw_content_persisted,false);
  assert(!encoded.includes('PRIVATE_ROUTER_ALPHA'));assert(!encoded.includes('30/10/2026'));assert.deepEqual(out.error.reason_codes,[]);
 }
});

test('component network recovery and exhausted route templates remain producer claims with no private subject',()=>{
 const notices=[
  [componentNotice('down'),'zigbee_component_unavailable'],[componentNotice('reminder'),'zigbee_component_unavailable'],
  [componentNotice('recovery'),'zigbee_component_recovery_notice'],[networkNotice('network_down'),'zigbee_network_unavailable'],
  [networkNotice('network_reminder'),'zigbee_network_unavailable'],[networkNotice('network_recovery'),'zigbee_network_recovery_notice'],
  [routeNotice('route_recovery'),'zigbee_route_recovery_notice'],[routeNotice('route_recovery_failed','MAC_NO_ACK',3,3),'zigbee_route_unconfirmed']
 ];
 for(const [notice,expected]of notices){const out=cleanNotice(notice),encoded=JSON.stringify(out);
  assert(out.message_codes.includes(expected),expected);assert.deepEqual(out.integration_codes,['zigbee']);
  assert(!encoded.includes('PRIVATE_COMPONENT_BETA'));assert(!encoded.includes('PRIVATE_ROUTER_ALPHA'));assert(!encoded.includes('30/10/2026'));
 }
 assert(cleanNotice(notices.at(-1)[0]).message_codes.includes('zigbee_attempts_3'));
});

test('Zigbee private tails and injected diagnostics cannot add claims or export source text',()=>{
 const notice=routeNotice();
 for(const tail of [' nome=PRIVATE_PERSON',' https://private.example.invalid/a?token=PRIVATE_TOKEN',
  ' latitude=PRIVATE_LATITUDE longitude=PRIVATE_LONGITUDE',' device_PRIVATE_IDENTIFIER 192.0.2.123',
  ' authentication failed NWK_NO_ROUTE iCloud']){
  const out=sanitizeContent(notice.title+tail,notice.message+tail),encoded=JSON.stringify(out);
  assert.deepEqual(out.reason_codes,['MAC_NO_ACK']);assert.deepEqual(out.integration_codes,['zigbee']);assert.deepEqual(out.error.reason_codes,[]);
  assert(out.redacted_fields.some(item=>item.reason==='non_allowlisted_text_may_contain_personal_data'));
  for(const text of ['PRIVATE_PERSON','private.example.invalid','PRIVATE_TOKEN','PRIVATE_LATITUDE','PRIVATE_LONGITUDE','PRIVATE_IDENTIFIER','192.0.2.123','authentication failed'])assert(!encoded.includes(text));
 }
});

test('mismatched titles unknown radio codes and invalid bounds stay unknown',()=>{
 const route=routeNotice(),down=networkNotice('network_down'),reminder=networkNotice('network_reminder');
 for(const [title,message]of [[componentNotice('down').title,route.message],[route.title,componentNotice('down').message],
  [reminder.title,down.message],[route.title+'Private',route.message],
  [route.title,routeNotice('route_failure','UNKNOWN_PRIVATE_RADIO_CODE').message],
  [route.title,routeNotice('route_failure','MAC_NO_ACK',6).message]]){
  const out=sanitizeContent(title,message);assert(!out.reason_codes.includes('MAC_NO_ACK'));assert(!out.reason_codes.includes('NWK_NO_ROUTE'));
  assert(!out.message_codes.includes('zigbee_route_failure'));assert(!out.message_codes.includes('zigbee_component_unavailable'));
  assert(!out.message_codes.includes('zigbee_network_unavailable'));assert(!JSON.stringify(out).includes('UNKNOWN_PRIVATE_RADIO_CODE'));
 }
});

test('Zigbee diagnostic enrichment preserves existing Events IDs revisions categories and receipt digest',()=>{
 const notice=routeNotice(),input={notification_id:'zigbee_route_synthetic',title:notice.title,message:notice.message,created_at:new Date(zigbeeClock).toISOString()};
 const original=new NotificationState();original.apply({type:'current',notifications:{}},zigbeeClock);
 original.apply({type:'added',notifications:{zigbee_route_synthetic:input}},zigbeeClock+1);
 const saved=original.snapshot(zigbeeClock+1),before=saved.notifications[0];
 before.diagnostics=sanitizeContent('Aviso não reconhecido','conteúdo antigo omitido');
 const events=structuredClone(saved.events),eventDigest=createHash('sha256').update(JSON.stringify(events)).digest('hex');
 const state=new NotificationState(saved);assert.equal(state.apply({type:'current',notifications:{zigbee_route_synthetic:input}},zigbeeClock+2),0);
 const after=state.snapshot(zigbeeClock+2).notifications[0];
 for(const field of ['id','revision','category','summary','category_basis'])assert.equal(after[field],before[field]);
 assert.deepEqual(state.events,events);assert.equal(createHash('sha256').update(JSON.stringify(state.events)).digest('hex'),eventDigest);
 assert(after.diagnostics.reason_codes.includes('MAC_NO_ACK'));assert.equal(state.sequence,original.sequence);
});
