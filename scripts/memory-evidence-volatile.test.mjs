import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { checkEvidence } from "./memory-evidence.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const note = (file, body) => `<!-- memory-record ${JSON.stringify({
  id: "exemplo", category: "KNOWN_FAILURE_MODE", kind: "VERIFIED_FACT", last_verified: "2026-11-16",
  evidence: [{ file, sha256: sha(body) }],
})} -->\n## Exemplo\n\nTexto.\n\n<!-- /memory-record -->\n`;

test("compose files cannot be memory evidence because update workers rewrite them", () => {
  const errors = checkEvidence(note("docker-compose.yml", "x"), () => "x");
  assert.match(errors.join("\n"), /volatile evidence source docker-compose\.yml/);
});

test("stable sources remain accepted", () => {
  assert.deepEqual(checkEvidence(note("docs/README.md", "x"), () => "x"), []);
});
