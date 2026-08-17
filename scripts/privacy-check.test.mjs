import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { scanEntries } from "./privacy-check.mjs";

function entry(file, text) {
  return { file, buffer: Buffer.from(text) };
}

test("reports only rule, location and category metadata", () => {
  const privateValue = ["person", "private", "resident"].join(".");
  const result = scanEntries([entry("fixture.yaml", `entity_id: ${privateValue}\n`)]);
  assert.equal(result[0].rule, "personal-person-entity");
  assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test("accepts logical roles and synthetic examples", () => {
  const result = scanEntries([entry("fixture.yaml", [
    "person.resident_primary",
    "device_tracker.mobile_secondary",
    "notify.mobile_primary",
    "Synthetic example: 192.168.20.10 # PRIVACY_TEST_FIXTURE",
  ].join("\n"))]);
  assert.deepEqual(result, []);
});

test("detects private network, coordinate, MAC, topic and denylist categories", () => {
  const result = scanEntries([entry("fixture.txt", [
    "host=10.23.45.67 # PRIVACY_TEST_FIXTURE",
    "point=-23.1234567 # PRIVACY_TEST_FIXTURE",
    "device=00:11:22:33:44:55 # PRIVACY_TEST_FIXTURE",
    "zigbee2mqtt/real_device/set",
    "Synthetic Resident Name",
  ].join("\n"))], { denylist: ["Synthetic Resident Name"] });
  assert.deepEqual(new Set(result.map((item) => item.rule)), new Set([
    "private-ipv4",
    "precise-coordinate",
    "mac-address",
    "residential-device-topic",
    "private-denylist",
  ]));
});

test("detects metadata in a synthetic PNG", () => {
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n"), Buffer.from("iTXt"), Buffer.from("synthetic")]);
  const result = scanEntries([{ file: "docs/assets/generated/example.png", buffer: png }]);
  assert.ok(result.some((item) => item.rule === "image-metadata"));
});

test("rejects private runtime paths and state artifacts", () => {
  const result = scanEntries([
    { file: "homeassistant/.storage/synthetic", buffer: Buffer.from("{}") },
    { file: "backups/synthetic.tar", buffer: Buffer.from("synthetic") },
    { file: "nodered/flows_cred.json", buffer: Buffer.from('{"synthetic":"state"}') },
  ]);
  assert.deepEqual(result.map((item) => item.rule), [
    "private-runtime-path",
    "private-runtime-path",
    "credential-state",
  ]);
});

test("allows only the declarative project hook inside private Codex runtime", () => {
  const result = scanEntries([
    { file: ".codex/hooks.json", buffer: Buffer.from('{"hooks":{}}') },
    { file: ".codex/session.json", buffer: Buffer.from("{}") },
  ]);
  assert.deepEqual(result.map((item) => item.rule), ["private-runtime-path"]);
  assert.equal(result[0].file, ".codex/session.json");
});

test("Git tracked mode excludes untracked files and staged mode sees staged content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-git-fixture-"));
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(run(["init", "-q"]).status, 0);
  assert.equal(run(["config", "user.name", "Synthetic Fixture"]).status, 0);
  assert.equal(run(["config", "user.email", "fixture@example.invalid"]).status, 0);
  fs.writeFileSync(path.join(root, "tracked.txt"), "safe synthetic fixture\n");
  assert.equal(run(["add", "tracked.txt"]).status, 0);
  assert.equal(run(["commit", "-qm", "fixture", "--author", "Fixture <fixture@example.invalid>"]).status, 0);
  fs.writeFileSync(path.join(root, "untracked.txt"), "person.private_fixture\n");
  assert.deepEqual(run(["ls-files"]).stdout.trim().split("\n"), ["tracked.txt"]);
  fs.writeFileSync(path.join(root, "staged.txt"), "person.private_staged\n");
  assert.equal(run(["add", "staged.txt"]).status, 0);
  assert.match(run(["diff", "--cached", "--name-only"]).stdout, /staged\.txt/);
});
