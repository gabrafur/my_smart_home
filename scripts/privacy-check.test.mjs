import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { scanEntries, scanGitRepository } from "./privacy-check.mjs";

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

test("detects contextual identity, contact, address and private-network categories", () => {
  const result = scanEntries([entry("fixture.yaml", [
    "owner_name: Private Fixture",
    "email: private.fixture@private.invalid.test",
    "phone: +55 11 99999-8888",
    "host: automation.private.lan",
    "ssid: PrivateFixtureWifi",
    "home_address: Private Fixture Street 123",
    "account_id: account987654321",
  ].join("\n"))]);
  assert.deepEqual(new Set(result.map((item) => item.rule)), new Set([
    "private-name-field",
    "private-email",
    "private-phone",
    "private-hostname",
    "private-ssid",
    "private-address",
    "private-account-id",
  ]));
});

test("allows documentation-only contact and logical placeholder values", () => {
  const result = scanEntries([entry("fixture.yaml", [
    "email: maintainer@example.com",
    "email: fixture@example.invalid",
    "email: github-actions@github.com",
    "ssid: CHANGE_ME",
    "owner_name: resident_primary",
    "account_id: synthetic",
  ].join("\n"))]);
  assert.deepEqual(result, []);
});

test("does not allow arbitrary GitHub-domain email addresses", () => {
  const result = scanEntries([entry("fixture.yaml", "email: private-fixture@github.com")]);
  assert.deepEqual(result.map((item) => item.rule), ["private-email"]);
});

test("detects metadata in a synthetic PNG", () => {
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n"), Buffer.from("iTXt"), Buffer.from("synthetic")]);
  const result = scanEntries([{ file: "docs/assets/generated/example.png", buffer: png }]);
  assert.ok(result.some((item) => item.rule === "image-metadata"));
});

test("allows the canonical synthetic social preview but rejects arbitrary image locations", () => {
  const png = Buffer.from("\x89PNG\r\n\x1a\n");
  assert.deepEqual(scanEntries([{ file: "docs/assets/github-social-preview.png", buffer: png }]), []);
  const result = scanEntries([{ file: "docs/assets/household.png", buffer: png }]);
  assert.equal(result[0].rule, "image-location");
});

test("does not treat SVG drawing coordinates as household coordinates", () => {
  const result = scanEntries([entry("docs/assets/architecture.svg", "<svg><path d=\"M 10.123456 20.123456\"/></svg>")]);
  assert.deepEqual(result, []);
});

test("allows precise benchmark metrics without allowing private network data", () => {
  const metric = ["0", "903125"].join(".");
  const address = ["10", "23", "45", "67"].join(".");
  const file = "docs/benchmarks/local-ai-high-potential/latest.json";
  assert.deepEqual(scanEntries([entry(file, `{"quality_score":${metric}}`)]), []);
  const result = scanEntries([entry(file, `{"quality_score":${metric},"endpoint":"${address}"}`)]);
  assert.deepEqual(result.map((item) => item.rule), ["private-ipv4"]);
});

test("allows precise metrics in the preserved v1 benchmark artifacts", () => {
  const metric = ["28", "773001"].join(".");
  const file = "docs/benchmarks/local-ai-high-potential/history/v1-2026-08-24/events.jsonl";
  assert.deepEqual(scanEntries([entry(file, `{"duration_seconds":${metric}}`)]), []);
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
  assert.deepEqual(scanGitRepository(root, "tracked").findings, []);
  fs.writeFileSync(path.join(root, "staged.txt"), "person.private_staged\n");
  assert.equal(run(["add", "staged.txt"]).status, 0);
  assert.equal(scanGitRepository(root, "staged").findings[0].file, "staged.txt");

  fs.writeFileSync(path.join(root, "tracked.txt"), "person.private_tracked\n");
  assert.equal(run(["add", "tracked.txt"]).status, 0);
  fs.writeFileSync(path.join(root, "untracked.txt"), "safe synthetic fixture\n");
  const trackedResult = scanGitRepository(root, "staged");
  assert.ok(trackedResult.findings.some((item) => item.file === "tracked.txt"));
});
