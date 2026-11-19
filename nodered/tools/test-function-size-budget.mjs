#!/usr/bin/env node
// Size budget for Function nodes. Large inline functions are hard to review and were the
// main cost of Node-RED maintenance (19/11/2026 survey: 848 functions, the largest 30 KB).
// New functions must stay under the limit; the existing oversized ones may only shrink.
// When one is refactored below the limit, delete it from the table.
import assert from "node:assert/strict";
import fs from "node:fs";

const LIMIT = 8000;
const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const OVERSIZED = new Map([
  ["global_observer_diagnostic_build", 30544],
  ["host_obs_timing_account", 15819],
  ["security_visual_local_excursion", 10973],
  ["global_observer_integration_lifecycle", 9973],
  ["vehicle_primary_refresh_policy_select_v1", 9788],
  ["mq_native_window_facts", 9744],
  ["host_obs_lifecycle", 9525],
  ["354c9839bfca592f", 9146],
  ["vehicle_primary_refresh_telemetry_v1", 9081],
  ["security_visual_arrival_facts", 8994],
  ["global_observer_ingest", 8178],
  ["vehicle_primary_api_error_log_v1", 8007]
]);

const failures = [];
for (const node of flows.filter((item) => item.type === "function")) {
  const size = String(node.func ?? "").length;
  const ceiling = OVERSIZED.get(node.id) ?? LIMIT;
  if (size > ceiling) failures.push(`${node.id} (${node.name}): ${size} > ${ceiling}`);
}
assert.deepEqual(failures, [], "Function node over its size budget; split it into smaller visual steps");
const ids = new Set(flows.map((node) => node.id));
const stale = [...OVERSIZED.keys()].filter((id) => !ids.has(id));
assert.deepEqual(stale, [], "Oversized table lists a node that no longer exists");
const shrunk = [...OVERSIZED].filter(([id, max]) => {
  const size = String(flows.find((node) => node.id === id)?.func ?? "").length;
  return size <= LIMIT && max > LIMIT;
}).map(([id]) => id);
assert.deepEqual(shrunk, [], "Function is now under the limit; remove it from the oversized table");
console.log(`Function size budget passed (${flows.filter((item) => item.type === "function").length} functions, ${OVERSIZED.size} grandfathered).`);
