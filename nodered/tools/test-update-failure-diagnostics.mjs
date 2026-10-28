import assert from 'node:assert/strict';
import fs from 'node:fs';
import {diagnosticFunctionSource} from './install-global-diagnostics.mjs';
const body=diagnosticFunctionSource(fs.readFileSync(new URL('functions/global-flow-observer-diagnostic-build.js',import.meta.url),'utf8'));
const run=new Function('msg',body);
const input={_global_observer_test:true,
 _global_observer:{flow_id:'daily_host_updates_tab',flow_label:'atualizacoes_diarias'},
 error:{message:'host_update_stage_failed stage=codex-cli request_id=PRIVATE-REQUEST failure_stage=registry-lookup stage_exit=69',
 source:{id:'daily_update_codex_cli_parse_result',type:'function',name:'Normalizar resultado Codex CLI'}}};
const result=run(input);
assert.equal(result._observer_public_diagnostic.simulated,true);
assert.equal(result._observer_public_diagnostic.dispatched,false);
assert.deepEqual(result._observer_public_diagnostic.error.reason_codes,['codex_registry_lookup_failed']);
assert(!JSON.stringify(result._observer_public_diagnostic).includes('PRIVATE-REQUEST'));
console.log('Updater diagnostics: actual generated adapter reaches dry-run without filesystem or notification effects.');
