import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { purgeHistory, RETENTION_DAYS } from "./purge-notification-history.mjs";
import { installNotificationHubs } from "./install-notification-hubs.mjs";

const source = await fs.readFile(new URL("functions/notification-hub-history-record.js", import.meta.url), "utf8");
const errors = [];
const serialize = (msg) => vm.runInNewContext(`(function () { ${source}\n })()`, {
  msg: structuredClone(msg), node: { error: (error) => errors.push(error) },
});
const request = {
  _msgid: "test-correlation", _notification_hub_channel: "mobile",
  _notification_hub_recipient: "resident_primary",
  payload: "Mensagem com acentuação\nsegunda linha",
  notification: { source: "test_source", recipients: ["resident_primary", "resident_secondary"], title: "Título", profile: "actionable", data: { tag: "fixture", actions: [{ action: "fixture", title: "Confirmar" }] } },
  _notification_hub_context: { private: "unrelated context must not leak" },
};
for (const channel of ["mobile", "alexa", "persistent"]) {
  const msg = { ...request, _notification_hub_channel: channel };
  const [entry, dry] = serialize(msg);
  const record = JSON.parse(entry.payload);
  assert.equal(dry, null);
  assert.equal(record.channel, channel);
  assert.equal(record.source, "test_source");
  assert.equal(record.message, request.payload);
  assert.equal(record.title, "Título");
  assert.deepEqual(record.data, request.notification.data);
  assert.equal(record.status, "accepted");
  assert.equal(record.recipient, "resident_primary");
  assert.equal(record.correlation_id, "test-correlation");
  assert.ok(!entry.payload.includes("unrelated context"));
  assert.match(entry.filename, new RegExp(`/notification-history/${channel}/\\d{4}-\\d{2}-\\d{2}T\\d{2}\\.jsonl$`));
  const simulated = serialize({ ...msg, notification: { ...msg.notification, test_mode: true } });
  assert.equal(simulated[0], null);
  assert.equal(simulated[1].filename, undefined);
  assert.equal(simulated[1].notification_delivery.dispatched, false);
  assert.equal(JSON.parse(simulated[1].payload).status, "simulated");
}
const realTest = serialize({ ...request, notification: { ...request.notification, test_mode: true, delivery_under_test: true } });
assert.equal(JSON.parse(realTest[0].payload).delivery_under_test, true);
const alexaOverride = serialize({ ...request, _notification_hub_channel: "alexa", notification: { ...request.notification, data: { message: "effective announce text" } } });
assert.equal(JSON.parse(alexaOverride[0].payload).message, "effective announce text");
assert.equal(serialize({ ...request, _notification_hub_channel: "../invalid" }), null);
assert.deepEqual(errors, ["NOTIFICATION_HISTORY_INVALID_CHANNEL"]);

// Topology: journal every successful service leg before aggregate completion.
const flows = JSON.parse(await fs.readFile(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((n) => [n.id, n]));
const generated = installNotificationHubs(structuredClone(flows));
assert.deepEqual(installNotificationHubs(structuredClone(generated)), generated, "hub generation is idempotent");
for (const channel of ["mobile", "alexa", "persistent"]) {
  const prefix = `notification_hub_${channel}_history`;
  const services = flows.filter((n) => n.z === `notification_hub_${channel}_tab` && n.type === "api-call-service");
  assert.ok(services.length);
  for (const service of services) {
    assert.ok(service.wires[0].includes(`${service.id}_history_out`));
    assert.deepEqual(byId.get(`${service.id}_history_out`).links, [`${prefix}_in`]);
    assert.ok(service.wires[0].some((id) => !id.endsWith("_history_out")), "logging must not block caller acknowledgement");
  }
  assert.equal(byId.get(`${prefix}_record`).func, source.trimEnd());
  assert.deepEqual(byId.get(`${prefix}_record`).wires, [[`${prefix}_file`], [`${prefix}_dry`]]);
  assert.equal(byId.get(`${prefix}_schedule`).repeat, "300");
  assert.equal(byId.get(`${prefix}_schedule`).once, true);
  assert.equal(byId.get(`${prefix}_purge`).addpay, false, "content must never be interpolated into a shell");
  assert.equal(byId.get(`${prefix}_purge`).command, `node /data/tools/purge-notification-history.mjs ${channel}`);
  assert.equal(byId.get(`${prefix}_file`).overwriteFile, "false");
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notification-history-test-"));
try {
  assert.equal(RETENTION_DAYS, 7);
  const now = Date.parse("2026-09-21T12:30:00.000Z");
  const row = (accepted_at) => JSON.stringify({ accepted_at, message: "fixture" });
  const boundary = path.join(directory, "2026-09-14T12.jsonl");
  await fs.writeFile(path.join(directory, "2026-09-14T11.jsonl"), row("2026-09-14T11:59:59.999Z"));
  await fs.writeFile(boundary, [row("2026-09-14T12:29:59.999Z"), row("2026-09-14T12:30:00.000Z"), row("2026-09-14T12:59:59.999Z"), ""].join("\n"));
  const current = path.join(directory, "2026-09-21T12.jsonl");
  await fs.writeFile(current, row("2026-09-21T12:29:00.000Z") + "\n");
  await fs.writeFile(path.join(directory, "unrelated.jsonl"), "leave untouched");
  const result = await purgeHistory(directory, now);
  assert.equal(result.removed_buckets, 1);
  const retained = (await fs.readFile(boundary, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(retained.length, 2);
  assert.equal(retained[0].accepted_at, "2026-09-14T12:30:00.000Z");
  assert.equal(await fs.readFile(path.join(directory, "unrelated.jsonl"), "utf8"), "leave untouched");
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await purgeHistory(directory, now)).removed_buckets, 0, "restart/repeated purge is idempotent");
  const concurrentRow = row("2026-09-21T12:30:00.000Z") + "\n";
  await Promise.all([purgeHistory(directory, now), fs.appendFile(current, concurrentRow)]);
  assert.ok((await fs.readFile(current, "utf8")).endsWith(concurrentRow));
  await fs.writeFile(boundary, "invalid-json\n");
  await assert.rejects(purgeHistory(directory, now));
  assert.equal(await fs.readFile(boundary, "utf8"), "invalid-json\n", "corrupt boundary is preserved on error");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
console.log("Notification history: serialization, individual accepts, dry-run, seven-day purge and restart passed.");
