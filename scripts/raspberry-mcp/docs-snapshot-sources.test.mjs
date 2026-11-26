// The root-installed docs index repair reads these paths while building
// maintenance_capabilities. Deleting any of them makes the tool answer
// operation_unavailable for every client (22/11 to 26/11/2026).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCUMENTS = [
  "RASPBERRY_MCP_EVIDENCE_STAGE2.md",
  "RASPBERRY_MCP_MAINTENANCE_MATRIX.md",
  "RASPBERRY_MCP_MAINTENANCE_STAGE1.md",
  "RASPBERRY_MCP_OPERATIONS_PROPOSAL.md",
];
const TARGETS = ["docs/i18n-manifest.json", "docs/README.md", "docs/README.en.md"];
const INSTALLED = "/usr/local/lib/raspberry-mcp/docs_snapshot_repair.py";

test("every source of the docs index repair exists as a regular file", () => {
  for (const name of [...TARGETS, ...DOCUMENTS.map((doc) => `docs/${doc}`)]) {
    const info = fs.lstatSync(path.join(root, name));
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${name} must stay a regular file`);
    assert.ok(info.size <= 262144, `${name} exceeds the repair read limit`);
  }
  const readme = fs.readFileSync(path.join(root, "docs/README.md"), "utf8");
  assert.match(readme, /<!-- mcp-maintenance-docs-index-v1 -->/);
});

test("the installed repair reads the same documents", { skip: !fs.existsSync(INSTALLED) && "repair not installed here" }, () => {
  const source = fs.readFileSync(INSTALLED, "utf8");
  const match = source.match(/^DOCUMENTS = \(([^)]*)\)/m);
  assert.ok(match, "DOCUMENTS tuple not found in the installed repair");
  const installed = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  assert.deepEqual(installed, DOCUMENTS);
});
