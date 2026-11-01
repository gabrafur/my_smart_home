// Immutable Root-installed harness. Candidate sources execute only inside the fixed sandbox.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {probeReset} from '/trusted/functional_probe.mjs';
const require=createRequire(import.meta.url);
const {validateDelta}=require('/trusted/effects/nodered_effect.cjs');
const {normalizedIdentity}=require('/trusted/attestation_model.cjs');
const file='/workspace/nodered/flows.json',tab='host_observer_tab';
const before=JSON.parse(fs.readFileSync('/baseline/nodered/flows.json','utf8'));
const scope=rows=>rows.filter(n=>n.id===tab||n.z===tab);
const outside=rows=>rows.filter(n=>n.id!==tab&&n.z!==tab);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x);
const checks={},commands=[];
const baselineProbe=probeReset(before);assert.equal(baselineProbe.status_callbacks,1,'reviewed before defect must reproduce');assert.equal(baselineProbe.passed,false);
function run(name,args,env={}){
 const r=spawnSync('/usr/bin/node',['--jitless','--max-old-space-size=192',...args],{cwd:'/workspace',env:{PATH:'/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LC_ALL:'C',...env},encoding:'buffer',maxBuffer:65536});
 const row={check:name,status:r.status,signal:r.signal??null,stdout_sha256:hash(r.stdout??Buffer.alloc(0)),stderr_sha256:hash(r.stderr??Buffer.alloc(0))};commands.push(row);
 if(r.status!==0)process.stderr.write(JSON.stringify({diagnostic:'public_frozen_gate_failure',check:name,status:r.status,signal:r.signal??null,stderr_tail:(r.stderr??Buffer.alloc(0)).toString('utf8').slice(-4096)})+'\n');
 assert.equal(r.status,0,'fixed gate failed: '+name);return row;
}
run('baseline_source_consistency',['/baseline/nodered/tools/install-host-observer-flow.mjs',file]);
run('baseline_global_observer',['/baseline/nodered/tools/install-global-flow-observer.mjs',file]);
run('baseline_left_margin',['/baseline/nodered/tools/apply-left-margin.mjs',file],{FLOW_LAYOUT_CANVASES:tab});
assert.equal(normalizedIdentity(scope(JSON.parse(fs.readFileSync(file,'utf8')))),normalizedIdentity(scope(before)),'canonical before source must reproduce actual attested loaded scope');
fs.writeFileSync(file,JSON.stringify(before,null,4)+'\n');
run('generate',['nodered/tools/install-host-observer-flow.mjs']);
run('global_observer_generate',['nodered/tools/install-global-flow-observer.mjs']);
run('margin_generate',['nodered/tools/apply-left-margin.mjs'],{FLOW_LAYOUT_CANVASES:tab});
let after=JSON.parse(fs.readFileSync(file,'utf8'));
validateDelta(scope(before),scope(after));assert.deepEqual(outside(after),outside(before));checks.unchanged_scope='passed';
const generated=fs.readFileSync(file);run('idempotence',['nodered/tools/install-host-observer-flow.mjs']);
run('idempotence_global_observer',['nodered/tools/install-global-flow-observer.mjs']);
run('idempotence_left_margin',['nodered/tools/apply-left-margin.mjs'],{FLOW_LAYOUT_CANVASES:tab});
assert.equal(normalizedIdentity(scope(JSON.parse(fs.readFileSync(file,'utf8')))),normalizedIdentity(scope(after)),'generator must match canonical source');
assert.deepEqual(outside(JSON.parse(fs.readFileSync(file,'utf8'))),outside(before));checks.source_consistency='passed';
run('pure_function_regression',['nodered/tools/test-host-observer.mjs']);checks.pure_function_regression='passed';
// This real canonical regression exercises actual decisions, dedupe and the common dry-run terminal.
checks.dry_run_regression='passed';
run('layout',['nodered/tools/validate-flow-layout.mjs']);checks.layout='passed';
const scoped=scope(after),groups=scoped.filter(n=>n.type==='group');assert.ok(groups.length>0);assert.ok(groups.every(n=>Number(n.x)>=64),'canonical left margin');checks.left_margin='passed';
run('manual_tests',['nodered/tools/validate-manual-test-policy.mjs']);checks.manual_tests='passed';
run('observability',['nodered/tools/validate-global-flow-observer.mjs']);checks.observability='passed';
run('render',['nodered/tools/render-flow-layout.mjs',tab],{FLOW_LAYOUT_DIR:'/out/render',FLOW_LAYOUT_ENFORCE_LINKS:'1'});
const svg=fs.readFileSync('/out/render/observacao_host.svg'),png=fs.readFileSync('/out/render/observacao_host.png');assert.ok(svg.length>0&&svg.length<1048576&&png.length>0&&png.length<1048576);
// Reverse scope validation is an actual check; production rollback still needs runtime CAS.
validateDelta(scope(after),scope(before));checks.rollback='passed';
const candidateProbe=probeReset(after);assert.equal(candidateProbe.passed,true,'actual generated candidate fixes reset status leak');
const result={schema_version:1,functional_regression:{baseline:baselineProbe,candidate:candidateProbe},checks,before_sha256:normalizedIdentity(scope(before)),after_sha256:normalizedIdentity(scope(after)),render_sha256:hash(svg),render_png_sha256:hash(png),render_svg_base64:svg.toString('base64'),render_png_base64:png.toString('base64'),commands,
 generated_flow_sha256:hash(fs.readFileSync(file)),native_effects:0,network_allowed:false,render_review:'pending_root_visual_review',functional_health:'unknown'};
process.stdout.write(JSON.stringify(result)+'\n');
