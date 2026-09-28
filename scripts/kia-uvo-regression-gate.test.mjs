import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateLocalRegressions } from "./kia-uvo-safe-update.mjs";

test("candidate regressions run against isolated candidate bytes and fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kia-regression-gate-test-"));
  try {
    const component = path.join(root, "candidate");
    fs.mkdirSync(component);
    const contract = path.join(component, "contract.txt");
    const regression = path.join(root, "regression.py");
    fs.writeFileSync(regression, `from pathlib import Path
import unittest

class CandidateContract(unittest.TestCase):
    def test_local_behavior(self):
        candidate = Path(__file__).resolve().parents[1] / "custom_components/kia_uvo/contract.txt"
        self.assertEqual(candidate.read_text(), "preserved")
`);
    fs.writeFileSync(contract, "preserved");
    assert.equal(validateLocalRegressions(component, regression), "passed");
    fs.writeFileSync(contract, "regressed");
    assert.throws(() => validateLocalRegressions(component, regression), /FAILED/);
    assert.equal(fs.readFileSync(contract, "utf8"), "regressed", "validation must not alter candidate files");
    assert.deepEqual(fs.readdirSync(component), ["contract.txt"], "test artifacts stay outside the candidate");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
