import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { digest, records } from "../memory-evidence.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
export const target = ".codex/memories/projeto/governanca-da-memoria.md";
export const source = "scripts/synthetic-memory-source.mjs";

export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-candidate-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  // Copy only the public checker inputs, never runtime or residential data.
  const inputs = trackedFiles.filter((f) => f.startsWith(".codex/memories/") || f.startsWith(".codex/instructions/") ||
    ["AGENTS.md", "MEMORY.md", "Makefile", "docker-compose.yml", "scripts/weekly-docs-review.prompt.md"].includes(f));
  const evidenceSources = inputs.filter((f) => f.startsWith(".codex/memories/")).flatMap((f) =>
    records(fs.readFileSync(path.join(repo, f), "utf8")).flatMap((r) => r.metadata.evidence.map((e) => e.file)));
  for (const file of new Set([...inputs, ...evidenceSources])) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  fs.writeFileSync(path.join(root, source), 'export const adapter = "blue";\n');
  trackedFiles.push(source);
  const candidate = () => ({
    file: target, expected_memory_sha256: digest(fs.readFileSync(path.join(root, target))),
    id: "synthetic-adapter", title: "Synthetic adapter", category: "IMPORTANT_DISCOVERY", kind: "VERIFIED_FACT",
    last_verified: "2026-09-21", evidence: [{ file: source, sha256: digest(fs.readFileSync(path.join(root, source))) }],
    body: "The synthetic adapter is blue.",
  });
  return { root, trackedFiles, candidate, read: () => fs.readFileSync(path.join(root, target), "utf8") };
}
