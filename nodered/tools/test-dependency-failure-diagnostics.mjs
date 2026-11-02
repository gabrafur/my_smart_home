import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';

const require=createRequire(import.meta.url);
const {errorDTO,contextDTO,sanitizeContent}=require('./lib/content_sanitizer.cjs');
const flows=JSON.parse(fs.readFileSync(new URL('../flows.json',import.meta.url),'utf8'));
const byId=new Map(flows.map(entry=>[entry.id,entry]));
const fixture='repository-dependency-update package=joi status=failed request_id=SYNTHETIC-REQUEST exit_code=1 reason=nodered_dependency_validation_failed';

function harness(){
  const state=new Map(),errors=[];
  const body=byId.get('daily_update_dependency_parse_result').func;
  const run=new Function('msg','node','flow',body);
  const flow={get:(key,store)=>state.get(`${store}:${key}`),set:(key,value,store)=>state.set(`${store}:${key}`,value)};
  return {state,errors,run:msg=>run(msg,{status(){},error:(message,value)=>errors.push({message,value})},flow)};
}

test('generated parser preserves the reviewed validation reason without inventing an exception',()=>{
  const h=harness();assert.deepEqual(h.run({payload:fixture}),[null,null,null]);
  assert.equal(h.errors.length,1);
  assert.equal(h.errors[0].value.payload.reason,'nodered_dependency_validation_failed');
  assert.equal(h.errors[0].value.payload.rollback,null);
  const dto=errorDTO({message:h.errors[0].message});
  assert.deepEqual(dto.reason_codes,['repository_dependency_update_failed','repository_dependency_validation_failed']);
  assert.equal(dto.exception_type,null);assert.deepEqual(dto.stack,[]);
  assert(!JSON.stringify(dto).includes('SYNTHETIC-REQUEST'));
  assert(!JSON.stringify(dto).includes('joi'));
});

test('legacy or unknown reasons stay generic and do not leak input fragments',()=>{
  for(const suffix of ['', ' reason=PRIVATE-REASON', ' reason=nodered_dependency_validation_failed-PRIVATE']){
    const h=harness();h.run({payload:'repository-dependency-update package=joi status=failed request_id=SYNTHETIC'+suffix});
    assert.equal(h.errors[0].value.payload.reason,null);
    const dto=errorDTO({message:h.errors[0].message});
    assert.deepEqual(dto.reason_codes,['repository_dependency_update_failed']);
    assert(!JSON.stringify(dto).includes('PRIVATE'));
  }
});

test('diagnostics expose only the reviewed node and never authorize effects',()=>{
  assert.deepEqual(contextDTO('daily_host_updates_tab','daily_update_dependency_parse_result'),{flow:'daily_host_updates_tab',node:'daily_update_dependency_parse_result'});
  assert.equal(contextDTO('daily_host_updates_tab','private-node').node,null);
  const dto=sanitizeContent('Falha em fluxo Node-RED','O fluxo atualizacoes_diarias registrou no nó Normalizar resultado npm: erro de execução.');
  assert(dto.message_codes.includes('node_dependency_result'));
  assert.equal(dto.untrusted_source_text,true);
});

test('dedupe keys and persistent state namespace remain unchanged',()=>{
  const h=harness();h.run({payload:fixture});h.run({payload:fixture});
  assert.equal(h.errors.length,1);assert.equal(h.state.size,1);
  const value=h.state.get('persistent:repository_dependency_last_result_v1');
  assert.equal(value.signature,'joi:SYNTHETIC-REQUEST:failed:');
  assert.equal(value.test_mode,false);
});

test('test mode traverses the parser with a separate memory namespace and no node error',()=>{
  const h=harness();h.run({payload:fixture});const count=h.errors.length;
  const result=h.run({payload:fixture,_repository_dependency_test:true});
  assert.equal(result[0].payload.test_mode,true);
  assert.equal(result[0].payload.reason,'nodered_dependency_validation_failed');
  assert.equal(h.errors.length,count);
  assert(h.state.has('undefined:repository_dependency_last_result_v1__test'));
  assert(h.state.has('persistent:repository_dependency_last_result_v1'));
});

test('rollback remains unknown unless an explicit supported status is present',()=>{
  for(const value of ['verified','unconfirmed','not_required','PRIVATE','verified-PRIVATE']){
    const h=harness();h.run({payload:fixture+' rollback='+value});
    assert.equal(h.errors[0].value.payload.rollback,['verified','unconfirmed','not_required'].includes(value)?value:null);
  }
});

test('nonfailed statuses preserve existing routes without emitting errors',()=>{
  for(const [status,index] of [['success',1],['deferred',2],['current',null],['running',null]]){
    const h=harness(),result=h.run({payload:`repository-dependency-update package=joi status=${status} request_id=SYNTHETIC`});
    assert.equal(h.errors.length,0);
    assert.deepEqual(result.map(Boolean),[0,1,2].map(i=>i===index));
  }
});

test('actual generated diagnostic terminal is a full dry-run with no filesystem access',()=>{
  const h=harness();h.run({payload:fixture});let writes=0;
  const msg={_global_observer_test:true,_global_observer:{flow_id:'daily_host_updates_tab',flow_label:'atualizacoes_diarias'},error:{message:h.errors[0].message,source:{id:'daily_update_dependency_parse_result',type:'function',name:'Normalizar resultado npm'}}};
  const result=vm.runInNewContext('(function(msg){'+byId.get('global_observer_diagnostic_build').func+'\n})(msg)',{msg,fs:new Proxy({},{get(){writes++;throw Error('filesystem access forbidden')}})},{timeout:100});
  assert.equal(writes,0);
  assert.equal(result._observer_public_diagnostic.simulated,true);
  assert.equal(result._observer_public_diagnostic.dispatched,false);
  assert(result._observer_public_diagnostic.error.reason_codes.includes('repository_dependency_validation_failed'));
});
