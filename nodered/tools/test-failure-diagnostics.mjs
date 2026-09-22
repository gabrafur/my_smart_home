import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {harness, flows} from "./startup-replay-harness.mjs";
import {purgeHistory} from "./purge-notification-history.mjs";

const by = new Map(flows.map(n => [n.id,n]));
const targets = id => by.get(id).wires[0].flatMap(target => {
  const n=by.get(target);
  return /^notification_hub_wire_out_/.test(target) ? by.get(n.links[0]).wires[0] : [target];
});
const body = await fs.readFile(new URL("functions/global-flow-observer-diagnostic-build.js",import.meta.url),"utf8");
assert.equal(by.get("global_observer_diagnostic_build").func,body.trimEnd());
assert.match(by.get("global_observer_diagnostic_build").initialize,/mode:0o700/);
const build = msg => new Function("msg",body)(msg);
const t = Date.parse("2026-01-10T12:00:00Z");
const error = new Error("worker_failed reason=cleanup_partial", {cause:new Error("EACCES while writing result")});
error.code="EACCES";error.source={id:"worker",type:"function",name:"Worker"};
const message = {_global_observer_test:true,observer_now:t,error,_global_observer:{flow_id:"test",flow_label:"Test"},payload:{reason:"cleanup_partial",request_id:"synthetic-request",stderr:"permission denied"}};
const record = build(message)._observer_diagnostic_record;
assert.match(record.error.stack,/worker_failed/);
assert.match(record.error.cause.message,/EACCES/);
assert.equal(record.error.code,"EACCES");
assert.equal(record.details.reason,"cleanup_partial");
assert.equal(record.details.stderr,"permission denied");
assert.deepEqual(record.truncated_fields,[]);
const syntheticCredential="synthetic-private-value";
const sanitized=build({error:{message:`password=${syntheticCredential} Bearer ${syntheticCredential} https://test.invalid/api?token=${syntheticCredential}`,stack:`token="${syntheticCredential}"`,cause:{message:`Cookie: ${syntheticCredential}`}},payload:{unrelated:syntheticCredential}})._observer_diagnostic_record;
assert.ok(!JSON.stringify(sanitized).includes(syntheticCredential));
assert.ok(!("unrelated" in sanitized.details));
const cycle={message:"recursive"};cycle.cause=cycle;
const clipped=build({error:{message:"x".repeat(25000),cause:cycle}})._observer_diagnostic_record;
assert.equal(clipped.error.message.length,20000);
assert.ok(clipped.truncated_fields.includes("error.message"));
assert.ok(clipped.truncated_fields.includes("cause_chain"));
assert.equal(build({_observer_diagnostic_origin:"dispatch",error,payload:{observer_kind:"node_error"},alert:{title:"error"}}),null,"notification dispatch must not duplicate the catch record");

// Full ingress, suppression, duplicate and domain paths end at the diagnostic dry-run.
const h=harness();
await h.run("global_observer_policy_validate",{topic:"connection_recovery_grace_seconds",payload:90});
const ctx=h.flowFor("global_flow_observer_tab");
for(const [index,type] of ["function","function","api-current-state"].entries()){
  await h.run("global_observer_events_in",{_global_observer_test:true,observer_now:t+index,error:{message:type==="function"?"synthetic failure":"not connected",stack:"synthetic stack",source:{id:"synthetic",type,name:"Test"}},_global_observer:{flow_id:"test",flow_label:"Test"}});
  const last=ctx.get("global_observer_diagnostic_last_test","memoryOnly");
  assert.equal(last.simulated,true);assert.equal(last.dispatched,false);
  assert.equal(last.record.recorded_at,new Date(t+index).toISOString(),"dedupe and startup suppression do not suppress recording");
}
await h.run("global_observer_alert_to_dispatch_in",{_global_observer_test:true,payload:{observer_kind:"domain_alert",reason:"worker_unavailable",incident_key:"worker"},alert:{title:"Failure",message:"Worker unavailable"}});
assert.equal(ctx.get("global_observer_diagnostic_last_test","memoryOnly").record.details.reason,"worker_unavailable");
for (const id of ["ha_one","ha_two"]) {
  await h.run("global_observer_events_in",{_global_observer_test:true,observer_now:t+1000,
    status:{text:"disconnected: transport closed",fill:"red",source:{id,type:"api-current-state",name:id}},
    _global_observer:{flow_id:"test",flow_label:"Test"}});
}
await h.run("global_observer_evaluate",{_global_observer_test:true,observer_now:t+61000});
const statusRecord=ctx.get("global_observer_diagnostic_last_test","memoryOnly").record;
assert.equal(statusRecord.event_type,"node_unavailable");
assert.equal(statusRecord.sources.length,2);
assert.ok(statusRecord.sources.every(source=>source.status_text==="disconnected: transport closed"));
await h.run("global_observer_test_reset_state",{});
assert.equal(ctx.get("global_observer_diagnostic_last_test","memoryOnly"),undefined);
assert.ok(targets("global_observer_internal_catch").includes("global_observer_internal_catch_diagnostic_out"));
assert.ok(targets("global_observer_notification_catch").includes("global_observer_notification_catch_diagnostic_out"));
assert.equal(by.get("global_observer_diagnostic_file").overwriteFile,"false");
assert.deepEqual(by.get("global_observer_diagnostic_failure").wires,[],"writer failure cannot recursively enter the writer or notifications");

// Persist serialized boundary output and read it in a separate process (restart).
const directory=await fs.mkdtemp(path.join(os.tmpdir(),"failure-diagnostics-test-"));
try {
  const current=path.join(directory,"2026-01-10T12.jsonl");
  await fs.appendFile(current,JSON.stringify(record)+"\n");
  await fs.appendFile(current,JSON.stringify(record)+"\n");
  const child=spawnSync(process.execPath,["-e",'const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\\n").map(JSON.parse);process.stdout.write(JSON.stringify(rows));',current],{encoding:"utf8"});
  assert.equal(child.status,0,child.stderr);
  assert.equal(JSON.parse(child.stdout).length,2,"each occurrence survives independently");
  assert.equal(JSON.parse(child.stdout)[0].error.cause.message,record.error.cause.message);
  const old=path.join(directory,"2026-01-01T00.jsonl");await fs.writeFile(old,JSON.stringify(record)+"\n");
  const unrelated=path.join(directory,"keep.txt");await fs.writeFile(unrelated,"preserved");
  await purgeHistory(directory,t,3);
  await assert.rejects(fs.stat(old),{code:"ENOENT"});
  assert.equal((await fs.readFile(current,"utf8")).trim().split("\n").length,2);
  assert.equal(await fs.readFile(unrelated,"utf8"),"preserved");
  assert.equal((await fs.stat(directory)).mode & 0o777,0o700);
  await assert.rejects(purgeHistory(directory,t,0),/invalid retention/);
} finally {await fs.rm(directory,{recursive:true,force:true});}
console.log("Failure diagnostics: detailed causes, redaction, suppressed/duplicate errors, dry-run, restart and retention passed.");
