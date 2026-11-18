import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listContainers, mergePeaks, readPeak, record } from "./container-memory-peaks.mjs";

test("daily merge keeps the highest peak per container and only 30 days", () => {
  let ledger = null;
  for (let day = 0; day < 32; day += 1) {
    const date = new Date(Date.UTC(2026, 10, 1 + day)).toISOString().slice(0, 10);
    ledger = mergePeaks(ledger, date, [{ name: "homeassistant", peak_mib: 900 }]);
  }
  assert.equal(Object.keys(ledger.days)[0], "2026-11-03");
  assert.equal(Object.keys(ledger.days).length, 30);
  let merged = mergePeaks(null, "2026-11-17", [{ name: "ai-bridge", peak_mib: 3759 }, { name: "homeassistant", peak_mib: 1092 }]);
  // A restart resets the kernel peak to a lower value; the day's maximum is kept.
  merged = mergePeaks(merged, "2026-11-17", [{ name: "ai-bridge", peak_mib: 1100 }, { name: "../etc", peak_mib: 1 }, { name: "nodered", peak_mib: -1 }]);
  assert.deepEqual(merged.days["2026-11-17"], { "ai-bridge": 3759, homeassistant: 1092 });
});

test("container listing and cgroup reading accept only exact identities and numbers", () => {
  const id = "a".repeat(64);
  const listed = listContainers({ execute: () => `${id} homeassistant\nshort bad\n${"b".repeat(64)} ../escape\n` });
  assert.deepEqual(listed, [{ id, name: "homeassistant" }]);
  const files = { "memory.peak": "1145044992\n", "memory.current": "935329792\n" };
  const read = (file) => files[path.basename(file)];
  assert.deepEqual(readPeak(id, { read }), { peak_mib: 1092, current_mib: 892 });
  assert.throws(() => readPeak(id, { read: () => "max" }), /memory_value_invalid/);
});

test("record writes the merged ledger atomically and skips unreadable containers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "container-peaks-"));
  const file = path.join(dir, "container-peaks.json");
  const peak = (id) => { if (id === "gone") throw new Error("ENOENT"); return { peak_mib: 768, current_mib: 670 }; };
  const result = record({ file, now: new Date("2026-11-17T16:00:00Z"), containers: [{ id: "x", name: "nodered" }, { id: "gone", name: "zigbee2mqtt" }], peak });
  assert.equal(result.recorded, 1);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.days, { "2026-11-17": { nodered: 768 } });
  assert.equal(saved.updated_at, "2026-11-17T16:00:00.000Z");
  assert.deepEqual(fs.readdirSync(dir), ["container-peaks.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sampled daily maximum uses memory.current, not the lifetime peak", () => {
  // ai-bridge kept a 3760 MiB lifetime peak for days without restarting; the sampled
  // maximum shows what each day actually used.
  let ledger = mergePeaks(null, "2026-11-18", [{ name: "ai-bridge", peak_mib: 3760, current_mib: 600 }]);
  ledger = mergePeaks(ledger, "2026-11-18", [{ name: "ai-bridge", peak_mib: 3760, current_mib: 820 }, { name: "nodered", peak_mib: 700, current_mib: -1 }]);
  ledger = mergePeaks(ledger, "2026-11-18", [{ name: "ai-bridge", peak_mib: 3760, current_mib: 500 }]);
  assert.deepEqual(ledger.days["2026-11-18"], { "ai-bridge": 3760, nodered: 700 });
  assert.deepEqual(ledger.sampled_days["2026-11-18"], { "ai-bridge": 820 });
  let old = mergePeaks(null, "2026-10-01", [{ name: "x", peak_mib: 1, current_mib: 1 }]);
  for (let day = 2; day <= 31; day += 1) old = mergePeaks(old, `2026-10-${String(day).padStart(2, "0")}`, [{ name: "x", peak_mib: 1, current_mib: 1 }]);
  assert.equal(Object.keys(old.sampled_days).length, 30);
  assert.equal(Object.keys(old.sampled_days)[0], "2026-10-02");
});
