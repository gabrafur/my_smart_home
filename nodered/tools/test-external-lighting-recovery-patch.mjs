import assert from "node:assert/strict";

import {
  disableAutomaticExternalLightingRecovery,
  removePrivateServiceData,
} from "./prepare-runtime-flows.mjs";

const flows = [{
  id: "24743bc9f254d1c1",
  type: "server-state-changed",
  outputInitially: true,
}];

assert.equal(disableAutomaticExternalLightingRecovery(flows), true);
assert.equal(flows[0].outputInitially, false);
assert.equal(
  disableAutomaticExternalLightingRecovery(flows),
  false,
  "o patch deve ser idempotente",
);

console.log("External-lighting restart confirmation safety patch test passed.");

const securityFlows = [
  {
    id: "70eb073f8191e69e",
    data: '{"role":"security_panel","action":"arm_away","data":{"code":"synthetic"}}',
  },
  {
    id: "8261c7cfb6756ca8",
    data: '{"role":"security_panel","action":"disarm","data":{"code":"synthetic"}}',
  },
];
assert.equal(removePrivateServiceData(securityFlows), true);
assert.deepEqual(securityFlows.map((node) => JSON.parse(node.data).data), [{}, {}]);
assert.equal(removePrivateServiceData(securityFlows), false);

console.log("Private service-data removal patch test passed.");
