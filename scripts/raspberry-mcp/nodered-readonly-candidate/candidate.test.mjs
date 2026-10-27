import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('.',import.meta.url));
const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
function run(command,args){const result=spawnSync(command,args,{cwd,env:childEnv,encoding:'utf8',timeout:45000,maxBuffer:1024*1024});assert.equal(result.error,undefined,'isolated test process failed');assert.equal(result.status,0,(result.stdout||'')+(result.stderr||''));}
test('NodeRED readonly Root/client and scoped deployment: isolated Python cases',()=>run('python3',['-I','-B','-m','unittest','discover','-s',cwd,'-p','test_*.py']));
test('NodeRED readonly projections and stage evidence, serial files',()=>run(process.execPath,['--max-old-space-size=128','--test','--test-concurrency=1','test_nodered_model.cjs','test_collector.cjs','test_ha_collector.cjs','test_runtime_facts.cjs','test_runtime_facts_integration.cjs','test_kia_model.cjs','kia-stage-model.test.cjs']));
