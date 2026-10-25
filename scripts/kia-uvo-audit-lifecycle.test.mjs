import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const source=fs.readFileSync(new URL("../nodered/tools/functions/daily-kia-audit-result.js",import.meta.url),"utf8");
function fixture() {
  let now=2000000000000;const values=new Map();const errors=[];
  class Clock extends Date {static now(){return now;}}
  const parser=new Function("msg","node","flow","Date",source);
  const node={error:(text)=>errors.push(text),warn:()=>{},status:()=>{}};
  const flow={get:(key)=>values.get(key),set:(key,value)=>values.set(key,value)};
  return {errors,values,now:()=>now,advance:ms=>{now+=ms;},run:(text,test=false)=>parser({_kia_update_test:test,payload:text},node,flow,Clock)};
}
test("old, missing or future evidence cannot resolve an audit failure",()=>{
 const f=fixture();const failed=f.run("status=failed request_id=failed reason=connect_timeout");
 assert.equal(failed[2].payload.observer_kind,"domain_alert");
 f.advance(1000);
 for(const [id,checked] of [["missing",""],["old",new Date(f.now()-2000).toISOString()],["future",new Date(f.now()+1000).toISOString()],["invalid","invalid"]]) {
  const result=f.run(`status=compatible mode=audit request_id=${id} latest_version=v3.20.0 checked_at=${checked}`);
  assert.equal(result[2],null);
  assert.equal(f.values.get("kia_uvo_update_last_result_v1").audit_incident_open,true);
 }
 const fresh=f.run(`status=compatible mode=audit request_id=fresh latest_version=v3.20.0 checked_at=${new Date(f.now()).toISOString()}`);
 assert.equal(fresh[2].payload.resolution,"later_audit_completed");
 assert.equal(fresh[2].payload.mobile_notification,false);
 assert.equal(f.values.get("kia_uvo_update_last_result_v1").audit_incident_open,false);
 assert.equal(f.errors.length,0);
});
test("six-hour cooldown, duplicate rejection and clock regression are explicit",()=>{
 const f=fixture();const payload="status=failed reason=connect_timeout request_id=one";
 assert.ok(f.run(payload)[2]);assert.equal(f.run(payload),null);
 f.advance(1000);assert.equal(f.run("status=failed request_id=two")[2],null);
 f.advance(6*60*60*1000);assert.ok(f.run("status=failed request_id=three")[2]);
 f.advance(-6*60*60*1000);assert.ok(f.run("status=failed request_id=four")[2],"future timestamps cannot silently suppress indefinitely");
});
test("synthetic failure follows domain route and uses separate state",()=>{
 const f=fixture();const out=f.run("status=failed request_id=test reason=private_sentinel",true);
 assert.equal(out[1],null);assert.equal(out[2]._global_observer_test,true);
 assert.equal(out[2].payload.reason,"audit_failed_unclassified");
 assert.equal(f.values.has("kia_uvo_update_last_result_v1"),false);
 assert.equal(f.errors.length,0);
});
