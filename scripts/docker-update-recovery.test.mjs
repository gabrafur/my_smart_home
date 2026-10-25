import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDockerRecoveryStore } from "./docker-update-recovery.mjs";
import { recreateAndVerify } from "./docker-auto-update.mjs";

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-recovery-store-"));
  try { return fn(root); } finally {
    if (fs.existsSync(path.join(root, ".local-state"))) fs.chmodSync(path.join(root, ".local-state"), 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("recovery uses the private worker store without changing shared state permissions", () => fixture(root => {
  const shared = path.join(root, ".local-state");fs.mkdirSync(shared, { mode: 0o555 });
  const store = createDockerRecoveryStore(root);
  store.record({ status: "pending", previous_compose: "before", candidate_compose: "after" });
  assert.equal(fs.statSync(shared).mode & 0o777, 0o555);
  assert.equal(fs.existsSync(store.legacy), false);
  assert.equal(fs.statSync(store.current).mode & 0o777, 0o600);
  assert.equal(store.hasPending(), true);
  store.clear();
  assert.equal(store.hasPending(), false);
  const receipts = fs.readdirSync(store.history);
  assert.equal(receipts.length, 1);
  const done = JSON.parse(fs.readFileSync(path.join(store.history, receipts[0])));
  assert.equal(done.status, "verified");
  assert.equal(done.previous_compose, "before");
  assert.equal(done.candidate_compose, "after");
}));

test("legacy and interrupted records remain blockers and are never removed", () => fixture(root => {
  const store = createDockerRecoveryStore(root);
  fs.mkdirSync(path.dirname(store.legacy));fs.writeFileSync(store.legacy, "{}");
  assert.equal(store.hasPending(), true);
  assert.equal(fs.existsSync(store.legacy), true);
  fs.unlinkSync(store.legacy);
  fs.mkdirSync(path.dirname(store.current), { mode: 0o700 });
  fs.writeFileSync(`${store.current}.tmp`, "interrupted");
  assert.equal(store.hasPending(), true);
  assert.equal(fs.readFileSync(`${store.current}.tmp`, "utf8"), "interrupted");
}));

test("a recovery write failure prevents any container recreation", async () => {
  let recreated = false;
  await assert.rejects(recreateAndVerify(["homeassistant"], {
    record: () => { throw new Error("EACCES fixture"); },
    recreate: () => { recreated = true; }, wait: () => {}, clear: () => {}, report: () => {},
  }), /EACCES/);
  assert.equal(recreated, false);
});
