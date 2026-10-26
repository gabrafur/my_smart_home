import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync(new URL('./promote-kia-uvo-candidate.mjs',import.meta.url),'utf8');
const helperStart=source.indexOf('export function promotionRequiresReconciliation(');
const promoteStart=source.indexOf('export async function promote(');
const end=source.indexOf('\nconst invoked =',promoteStart);
assert(helperStart>=0&&promoteStart>helperStart&&end>promoteStart);
const code=source.slice(helperStart,end).replaceAll('export function ','function ').replace('export async function ','async function ')+ '\nglobalThis.invoke = promote; globalThis.guard = promotionRequiresReconciliation;';
new vm.Script(code); // Compile the actual candidate control flow before scenarios.
const SHA='a'.repeat(40),OTHER='b'.repeat(40);
function harness(promotion,{exists=true,corrupt=false,failAt=null}={}){
 let stored=promotion;
 const before=structuredClone(promotion);
 const effects={apply:0,deploy:0,restarts:0,cleanup:0,run:0,privateWrites:[],publicWrites:0,fetch:[]};
 const candidate={target:'v3.20.0',branch:'codex/kia-uvo-3.20.0-20261026t030000z',commit:SHA};
 const context={
  configureGitHubSshTransport(){},workerStatusPath:'worker',promotionStatusPath:'promotion',
  dailyUpdateTriggerDir:'trigger',repoRoot:'repo',safeUpdater:'safe-updater',checkOnly:false,
  fs:{existsSync(p){return p==='worker'||p==='promotion'&&exists;},mkdtempSync(){return '/synthetic';},rmSync(){effects.cleanup++;}},
  readJson(p){if(p==='worker')return {state:'success',pushed:true,...candidate};if(corrupt)throw Error('synthetic invalid JSON');if(!exists&&stored===null)throw Error('synthetic missing receipt');return stored;},
  normalizeCandidateStatus(v){return v;},
  shouldResumeCandidateCleanup(p,c){return p?.state==='main_published'&&p.source_commit===c.commit;},
  writePublicStatus(){effects.publicWrites++;},
  writeStatus(row){effects.privateWrites.push(row);stored={...stored,...row};},
  findActiveHostUpdateStage(){return null;},workingTreePaths(){return [];},
  fetchAndValidate(c,o){effects.fetch.push(o.resumeGit);if(failAt==='candidate_validation')throw Error('PRIVATE_TOKEN=password');return ['fixed-path'];},
  extractCandidate(){if(failAt==='candidate_extract')throw Error('PRIVATE_TOKEN=password');},readHaToken(){return 'SYNTHETIC_NOT_SECRET';},
  run(cmd,args){effects.run++;if(args.includes('apply-candidate'))effects.apply++;if(args.includes('apply-candidate')&&failAt==='runtime_apply'||args.includes('check-candidate')&&failAt==='candidate_preflight')throw Error('PRIVATE_TOKEN=password');},
  commitAndPush(){if(failAt==='git_publication')throw Error('PRIVATE_TOKEN=password');return 'published';},deleteCandidateBranch(){effects.cleanup++;if(failAt==='candidate_cleanup')throw Error('PRIVATE_TOKEN=password');return true;},
  log(){},os:{tmpdir(){return '/tmp';}},path:{join(...a){return a.join('/');}},
  PromotionDeferred:class extends Error{},
 };
 vm.runInNewContext(code,context,{timeout:1000});
 return {context,effects,before,promotion};
}
const uncertainEffects=e=>{assert.equal(e.apply,0);assert.equal(e.deploy,0);assert.equal(e.restarts,0);assert.equal(e.cleanup,0);assert.equal(e.run,0);assert.equal(e.privateWrites.length,0);assert.equal(e.fetch.length,0);};
for(const sha of [SHA,OTHER])test('existing applying blocks regardless candidate SHA '+sha[0],async()=>{
 const h=harness({state:'applying',source_commit:sha,target:'v3.20.0',operation_id:'preserved'});
 assert.equal(await h.context.invoke(),false);uncertainEffects(h.effects);assert.deepEqual(h.promotion,h.before);
});
for(const state of ['unknown','uncertain','',undefined])test('unknown existing receipt blocks '+String(state),async()=>{
 const h=harness({state,source_commit:SHA});assert.equal(await h.context.invoke(),false);uncertainEffects(h.effects);assert.deepEqual(h.promotion,h.before);
});
test('corrupt existing receipt cannot become first run',async()=>{
 const h=harness(null,{corrupt:true});assert.equal(await h.context.invoke(),false);uncertainEffects(h.effects);
});
for(const state of ['completed','failed'])test('terminal same-SHA dedupe unchanged '+state,async()=>{
 const h=harness({state,source_commit:SHA,operation_id:'preserved'});
 assert.equal(await h.context.invoke(),false);uncertainEffects(h.effects);assert.equal(h.effects.publicWrites,1);assert.deepEqual(h.promotion,h.before);
});
for(const state of ['runtime_applied','applied_pending_git'])test('Git-only resume unchanged '+state,async()=>{
 const h=harness({state,source_commit:SHA});assert.equal(await h.context.invoke(),true);
 assert.equal(h.effects.apply,0);assert.equal(h.effects.run,0);assert.deepEqual(h.effects.fetch,[true]);
 assert.deepEqual(h.effects.privateWrites.map(r=>r.state),['main_published','completed']);
});
test('published candidate resumes cleanup only',async()=>{
 const h=harness({state:'main_published',source_commit:SHA,commit:'published'});
 assert.equal(await h.context.invoke(),true);assert.equal(h.effects.apply,0);assert.equal(h.effects.run,0);
 assert.equal(h.effects.cleanup,1);assert.equal(h.effects.fetch.length,0);assert.equal(h.effects.privateWrites[0].state,'completed');
});
for(const state of ['completed','deferred'])test('known non-uncertain other candidate behavior preserved '+state,async()=>{
 const h=harness({state,source_commit:OTHER});assert.equal(await h.context.invoke(),true);
 assert.equal(h.effects.apply,1);assert.deepEqual(h.effects.fetch,[false]);
 assert.equal(h.effects.privateWrites[0].state,'applying');
});
test('genuine absent receipt retains initial application path',async()=>{
 const h=harness(null,{exists:false});assert.equal(await h.context.invoke(),true);assert.equal(h.effects.apply,1);
});
test('check mode also refuses unresolved applying before candidate extraction',async()=>{
 const h=harness({state:'applying',source_commit:OTHER});assert.equal(await h.context.invoke({checkOnly:true}),false);uncertainEffects(h.effects);
});

for(const stage of ['candidate_validation','candidate_extract','runtime_apply','git_publication','candidate_cleanup'])test('failure captures observed fixed stage '+stage,async()=>{
 const h=harness(null,{exists:false,failAt:stage});await assert.rejects(h.context.invoke());
 const row=h.effects.privateWrites.at(-1);assert.equal(row.failure_stage,stage);
 assert.equal(typeof row.reason_code,'string');assert.ok(!row.reason_code.includes('PRIVATE'));
 if(stage==='runtime_apply'){assert.equal(row.state,'failed');assert.equal(row.effect_state,'runtime_outcome_unknown');assert.equal(row.reason_code,'runtime_application_unconfirmed');assert.equal(h.effects.apply,1);}
 if(stage==='git_publication'){assert.equal(row.state,'applied_pending_git');assert.equal(row.effect_state,'publication_outcome_unknown');assert.equal(h.effects.apply,1);}
 if(['candidate_validation','candidate_extract'].includes(stage)){assert.equal(h.effects.apply,0);assert.equal(row.effect_state,'runtime_not_attempted');}
 if(stage==='candidate_cleanup'){assert.equal(row.state,'main_published');assert.equal(row.effect_state,'cleanup_outcome_unknown');}
});
test('check-only failure never claims runtime application',async()=>{
 const h=harness(null,{exists:false,failAt:'candidate_preflight'});await assert.rejects(h.context.invoke({checkOnly:true}));
 const row=h.effects.privateWrites.at(-1);assert.equal(row.failure_stage,'candidate_preflight');assert.equal(row.effect_state,'runtime_not_attempted');assert.equal(h.effects.apply,0);
});
test('cleanup-only failure preserves published state and never applies',async()=>{
 const h=harness({state:'main_published',source_commit:SHA,commit:'published'},{failAt:'candidate_cleanup'});await assert.rejects(h.context.invoke());
 const row=h.effects.privateWrites.at(-1);assert.equal(row.state,'main_published');assert.equal(row.failure_stage,'candidate_cleanup');assert.equal(h.effects.apply,0);
});

for (const state of ['runtime_applied','applied_pending_git','main_published']) test('different candidate cannot overwrite pending lifecycle '+state,async()=>{
 const h=harness({state,source_commit:OTHER});assert.equal(await h.context.invoke(),false);uncertainEffects(h.effects);assert.deepEqual(h.promotion,h.before);
});
for (const failure of [{},{failure_stage:'runtime_apply',effect_state:'runtime_outcome_unknown'},{failure_stage:'candidate_validation',effect_state:'unknown'},{failure_stage:'PRIVATE',effect_state:'runtime_not_attempted'}]) test('different candidate cannot overwrite failed uncertain runtime '+JSON.stringify(failure),async()=>{
 const h=harness({state:'failed',source_commit:OTHER,...failure});assert.equal(await h.context.invoke(),false);uncertainEffects(h.effects);assert.deepEqual(h.promotion,h.before);
});
for (const failure_stage of ['candidate_validation','candidate_extract','candidate_preflight']) test('new candidate allowed only after positively recorded no runtime attempt '+failure_stage,async()=>{
 const h=harness({state:'failed',source_commit:OTHER,failure_stage,effect_state:'runtime_not_attempted'});assert.equal(await h.context.invoke(),true);assert.equal(h.effects.apply,1);assert.deepEqual(h.effects.fetch,[false]);
});
