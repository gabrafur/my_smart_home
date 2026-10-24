import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const worker = fileURLToPath(new URL("./process-update-stage-request.sh", import.meta.url));

for (const exitCode of [0, 1]) {
  test(`offsite worker consumes exit ${exitCode} once and preserves the reported outcome`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-result-synthetic-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const child = path.join(root, "synthetic-stage.sh");
    const trigger = path.join(root, "trigger");
    fs.mkdirSync(trigger);
    // No production stage, Docker, credentials, backup or upload is invoked.
    fs.writeFileSync(child, `#!/bin/sh
printf 'started\\n' >> "$SYNTHETIC_STARTS"
${exitCode === 0 ? 'printf "capture_verified=true remote_verified=true retention_eligible=1 retention_pruned=0 retention_mode=observe_only\\n" > "$DAILY_UPDATE_DETAIL_FILE"' : ':'}
exit ${exitCode}
`, { mode: 0o700 });
    fs.writeFileSync(path.join(trigger, "offsite-backup-requested"), "synthetic-operation\n");
    const args = [worker, "offsite-backup"];
    const options = { encoding: "utf8", timeout: 5000, env: {
      PATH: "/usr/bin:/bin", LC_ALL: "C", DAILY_UPDATE_TRIGGER_DIR: trigger,
      HOST_UPDATE_STAGE_SCRIPT: child, SYNTHETIC_STARTS: path.join(root, "starts"),
    } };
    assert.equal(spawnSync("/bin/sh", args, options).status, exitCode);
    const resultFile = path.join(trigger, "offsite-backup-result");
    const result = fs.readFileSync(resultFile, "utf8");
    assert.match(result, new RegExp(`status=${exitCode === 0 ? "success" : "failed"} `));
    if (exitCode === 0) assert.match(result, /retention_pruned=0 retention_mode=observe_only/);
    else assert.match(result, /exit_code=1/);
    assert(!fs.existsSync(path.join(trigger, "offsite-backup-requested")));
    assert(!fs.existsSync(path.join(trigger, "offsite-backup-processing")));
    assert.equal(spawnSync("/bin/sh", args, options).status, 0);
    assert.equal(fs.readFileSync(path.join(root, "starts"), "utf8"), "started\n");
    assert.equal(fs.readFileSync(resultFile, "utf8"), result);
  });
}
