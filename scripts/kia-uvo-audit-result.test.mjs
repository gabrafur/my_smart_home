import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const worker=fileURLToPath(new URL("./process-kia-uvo-update-request.sh",import.meta.url));
function fixture(t, reason, exitCode=1) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"kia-audit-reason-test-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const trigger=path.join(root,"trigger");fs.mkdirSync(trigger);
  const fake=path.join(root,"node");
  fs.writeFileSync(fake, '#!/bin/sh\nif [ "$2" = status ]; then echo "kia-uvo-update status=compatible"; exit 0; fi\nprintf "%s" "$TEST_REASON" >&3\nexit "$TEST_EXIT"\n');fs.chmodSync(fake,0o755);
  const updater=path.join(root,"updater");fs.writeFileSync(updater,"fixture");
  const request="synthetic-request-id\naudit\nv3.20.0\n";
  fs.writeFileSync(path.join(trigger,"kia-uvo-requested"),request);
  const env={...process.env,DAILY_UPDATE_TRIGGER_DIR:trigger,KIA_UVO_UPDATE_NODE_BIN:fake,KIA_UVO_UPDATE_SCRIPT:updater,TEST_REASON:reason,TEST_EXIT:String(exitCode)};
  return {trigger,request,env,run:()=>spawnSync(worker,[],{env,encoding:"utf8",timeout:10000})};
}
for(const [input,expected] of [["connect_timeout\n","connect_timeout"],["private sentinel\n","audit_failed_unclassified"],["connect_timeout\nprivate sentinel","audit_failed_unclassified"],["x".repeat(2048),"audit_failed_unclassified"],["","audit_failed_unclassified"]]) {
  test(`worker exports only closed reason: ${expected} (${input.length} bytes)`,t=>{
    const f=fixture(t,input);assert.equal(f.run().status,1);
    const result=fs.readFileSync(path.join(f.trigger,"kia-uvo-result"),"utf8");
    assert.match(result,new RegExp(`reason=${expected}\\n$`));
    assert.match(result,/status=failed request_id=synthetic-request-id mode=audit latest_version=v3.20.0 exit_code=1/);
    assert.doesNotMatch(result,/private sentinel/);
    assert.equal(fs.existsSync(path.join(f.trigger,"kia-uvo-processing")),false);
    assert.equal(f.run().status,0,"consumed failure must not repeat");
    assert.equal(fs.readFileSync(path.join(f.trigger,"kia-uvo-result"),"utf8"),result);
    assert.equal(fs.readdirSync(f.trigger).some(n=>n.startsWith(".kia-uvo-diagnostic.")),false);
  });
}
test("deferral preserves exact request and removes diagnostic temporary",t=>{
  const f=fixture(t,"connect_timeout",75);assert.equal(f.run().status,75);
  assert.equal(fs.readFileSync(path.join(f.trigger,"kia-uvo-requested"),"utf8"),f.request);
  assert.match(fs.readFileSync(path.join(f.trigger,"kia-uvo-result"),"utf8"),/status=deferred/);
  assert.equal(fs.readdirSync(f.trigger).some(n=>n.startsWith(".kia-uvo-diagnostic.")),false);
});
test("success remains compatible without a failure reason",t=>{
  const f=fixture(t,"",0);assert.equal(f.run().status,0);
  assert.match(fs.readFileSync(path.join(f.trigger,"kia-uvo-result"),"utf8"),/status=compatible/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.trigger,"kia-uvo-result"),"utf8"),/reason=/);
});
