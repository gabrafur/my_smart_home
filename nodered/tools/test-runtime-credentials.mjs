import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { removeGeneratedFallback } from "./prepare-runtime-credentials.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-runtime-credentials-"));
const file = path.join(directory, ".config.runtime.json");
try {
  fs.writeFileSync(file, JSON.stringify({ instanceId: "synthetic", _credentialSecret: "generated" }));
  assert.equal(removeGeneratedFallback(file, "explicit"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { instanceId: "synthetic" });
  assert.equal(removeGeneratedFallback(file, "explicit"), false);

  fs.writeFileSync(file, JSON.stringify({ instanceId: "synthetic", _credentialSecret: "keep-without-explicit" }));
  assert.equal(removeGeneratedFallback(file, ""), false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))._credentialSecret, "keep-without-explicit");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("Node-RED runtime credential preparation tests passed.");
