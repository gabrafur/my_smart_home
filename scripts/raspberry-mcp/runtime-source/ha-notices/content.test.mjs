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
