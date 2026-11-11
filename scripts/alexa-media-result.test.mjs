import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const reader = fileURLToPath(new URL("./read-host-alexa-media-update-result.sh", import.meta.url));

test("the Alexa result reader accepts a blocked audit and still rejects unknown states", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "alexa-media-blocked-result-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const resultFile = path.join(fixture, "alexa-media-result");
  const env = { ...process.env, ALEXA_MEDIA_UPDATE_RESULT_FILE: resultFile };
  fs.writeFileSync(resultFile,
    "alexa-media-update status=blocked target=v5.16.1 patch_state=absorbed reason=public_memory_invalid private=private_sentinel request_id=blocked-audit\n");

  const blocked = spawnSync(reader, [], { encoding: "utf8", env });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stderr, "");
  assert.equal(blocked.stdout,
    "alexa-media-update status=blocked target=v5.16.1 request_id=blocked-audit\n");

  fs.writeFileSync(resultFile, "alexa-media-update status=unrecognized target=v5.16.1\n");
  const invalid = spawnSync(reader, [], { encoding: "utf8", env });
  assert.equal(invalid.status, 65);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /result is invalid/);
});
