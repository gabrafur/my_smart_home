import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const folder='./runtime-source/ha-notices/';
const {errorDTO,contextDTO,sanitizeContent}=require(folder+'content_sanitizer.cjs');
test('reviewed updater failure exposes its stage without a request ID or invented network cause',()=>{
 const value=errorDTO({message:'host_update_stage_failed stage=codex-cli request_id=PRIVATE-REQUEST failure_stage=registry-lookup stage_exit=69'});
 assert.deepEqual(value.reason_codes,['codex_registry_lookup_failed']);
 assert.equal(value.exception_type,null);assert.deepEqual(value.stack,[]);
 assert.equal(value.collection_error,null);assert(!JSON.stringify(value).includes('PRIVATE-REQUEST'));
 assert.deepEqual(contextDTO('daily_host_updates_tab','daily_update_codex_cli_parse_result'),{flow:'daily_host_updates_tab',node:'daily_update_codex_cli_parse_result'});
 const unknown=errorDTO({message:'host_update_stage_failed stage=private-worker request_id=PRIVATE failure_stage=registry-lookup stage_exit=69'});
 assert.deepEqual(unknown.reason_codes,[]);
 const body=sanitizeContent('Falha em fluxo Node-RED','O fluxo atualizacoes_diarias registrou no nó Normalizar resultado Codex CLI: erro de execução.');
 assert(body.message_codes.includes('flow_updates'));assert(body.message_codes.includes('node_codex_result'));
 for(const name of ['content_sanitizer.cjs','diagnostic_templates.json'])assert.deepEqual(fs.readFileSync(new URL(folder+name,import.meta.url)),fs.readFileSync(new URL('../../nodered/tools/lib/'+name,import.meta.url)));
});
