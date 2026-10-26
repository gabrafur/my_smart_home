import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { promotionStageEvidence, promotionStageReason, publicPromotionReason, nextPromotionStatus } from './promote-kia-uvo-candidate.mjs';
const source=fs.readFileSync(new URL('./promote-kia-uvo-candidate.mjs',import.meta.url),'utf8');
for(const value of ['PRIVATE_TOKEN=secret','__proto__','constructor','toString',null,undefined,42,{}])test('unrecognized stage never becomes diagnostic text '+String(value),()=>{
 assert.deepEqual(promotionStageEvidence(value),{failure_stage:null,effect_state:'unknown'});
 assert.equal(promotionStageReason(value),'promotion_stage_unknown');
 assert.equal(publicPromotionReason(value),null);
});
test('old failure without stage stays unknown and is never reclassified',()=>{
 const previous={state:'failed',source_commit:'a'.repeat(40),reason:'PRIVATE_REASON',reason_code:null};
 const result=nextPromotionStatus(previous,{state:'failed',source_commit:'a'.repeat(40),reason_code:null},'2026-10-26T06:11:36.374Z');
 assert.equal(result.failure_stage,null);assert.equal(result.effect_state,'unknown');assert.equal(result.reason_code,null);
});
test('successful progress clears previous failure stage',()=>{
 const previous={state:'failed',failure_stage:'runtime_apply',effect_state:'runtime_outcome_unknown'};
 const result=nextPromotionStatus(previous,{state:'runtime_applied',reason:null});
 assert.equal(result.failure_stage,null);assert.equal(result.effect_state,'unknown');assert.equal(result.reason_code,null);
});
test('actual public writer exports only fixed fields and stage enums',()=>{
 const start=source.indexOf('function writePublicStatus('),end=source.indexOf('\nexport function publicPromotionReason',start);
 let publicRow=null;
 const ctx={promotionPublicStatusPath:'synthetic-public-status',process:{pid:1},publicPromotionReason,promotionStageEvidence,
 fs:{writeFileSync(_path,content){publicRow=JSON.parse(content);},renameSync(){}}};
 vm.runInNewContext(source.slice(start,end)+'\nglobalThis.write=writePublicStatus;',ctx,{timeout:1000});
 ctx.write({state:'failed',target:'v3.20.0',updated_at:'2026-10-26T21:00:00Z',failure_stage:'runtime_apply',reason_code:'runtime_application_unconfirmed',reason:'PRIVATE_REASON',token:'PRIVATE_TOKEN',stack:'PRIVATE_STACK'});
 assert.equal(publicRow.failure_stage,'runtime_apply');assert.equal(publicRow.effect_state,'runtime_outcome_unknown');assert.equal(publicRow.reason_code,'runtime_application_unconfirmed');
 assert.ok(!JSON.stringify(publicRow).includes('PRIVATE'));
 assert.deepEqual(Object.keys(publicRow).sort(),['schema_version','state','target','updated_at','reason_code','failure_stage','effect_state'].sort());
});
