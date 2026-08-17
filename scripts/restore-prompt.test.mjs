import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const promptFile = path.join(repositoryRoot, "prompts/restore-smart-home.prompt.md");

test("canonical restore prompt delegates critical operations to deterministic scripts", () => {
  const prompt = fs.readFileSync(promptFile, "utf8");
  for (const required of [
    "AGENTS.md",
    "MEMORY.md",
    "knowledge_not_versioned",
    "fresh_install",
    "restore-plan",
    "restore-verify",
    "RESTORE_PRIVATE_STATE",
    "restore-apply",
    "ai-context-recovery.mjs",
    "rollback",
    "Relatório final",
  ]) assert.ok(prompt.includes(required), `prompt requirement is missing: ${required}`);
  assert.match(prompt, /autorização explícita/i);
  assert.match(prompt, /somente os scripts versionados executam validação ou cópia/i);
});

test("canonical restore prompt excludes private runtime as documentary context", () => {
  const prompt = fs.readFileSync(promptFile, "utf8");
  for (const privateRuntime of [".agent-history/", ".claude/", "runtime privado de", ".local-secrets/"]) {
    assert.ok(prompt.includes(privateRuntime), `private runtime prohibition is missing: ${privateRuntime}`);
  }
  assert.match(prompt, /Não consulte históricos privados/);
});
