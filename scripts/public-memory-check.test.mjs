import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkPublicMemory } from "./public-memory-check.mjs";

function createFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "public-memory-check-"));
  const files = {
    "AGENTS.md": `# Agents

\`.codex/memories/<assunto>/<nome-descritivo>.md\`

1. código e configuração executável atual;
2. testes e contratos executáveis;
3. documentação operacional atual;
4. decisões arquiteturais vigentes;
5. memória versionada dos agentes.
`,
    "MEMORY.md": `# Índice

Fonte: \`.codex/memories/projeto/indice.md\`.

- [Tópico](.codex/memories/topico/topico.md)
- [Governança](.codex/memories/governanca/governanca-da-memoria.md)
`,
    ".codex/memories/projeto/indice.md": `# Índice canônico

- [Tópico](../topico/topico.md)
- [Governança](../governanca/governanca-da-memoria.md)
`,
    ".codex/memories/topico/topico.md": `# Tópico

Consulte [a fonte](../../../docs/FONTE.md).
`,
    ".codex/memories/governanca/governanca-da-memoria.md": `# Governança

Consulte [o guia](../../../docs/MEMORIA_VERSIONADA_AGENTES.md) e rode \`make validate-public\`.
`,
    "docs/FONTE.md": "# Fonte\n",
    "docs/MEMORIA_VERSIONADA_AGENTES.md": "# Governança da memória\n",
    "scripts/weekly-docs-review.prompt.md": `# Revisão

## Memória versionada dos agentes

Revise \`.codex/memories/**\`.
`,
    "scripts/public-memory-check.mjs": "// fixture\n",
    "Makefile": `validate-public:
\tnode scripts/public-memory-check.mjs
`,
  };
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return { repoRoot, trackedFiles: Object.keys(files) };
}

test("accepts a coherent public memory graph", () => {
  const fixture = createFixture();
  const result = checkPublicMemory(fixture);
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.thematicMemories, 2);
});

test("reports an orphaned thematic memory", () => {
  const fixture = createFixture();
  const orphan = ".codex/memories/orfa/memoria-orfa.md";
  const absolute = path.join(fixture.repoRoot, orphan);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, "# Órfã\n");
  fixture.trackedFiles.push(orphan);

  const result = checkPublicMemory(fixture);
  assert.ok(result.errors.some((error) => error.includes(`${orphan}: orphaned from MEMORY.md`)));
  assert.ok(result.errors.some((error) => error.includes(`orphaned from .codex/memories/projeto/indice.md`)));
});

test("reports broken links without reading an untracked target", () => {
  const fixture = createFixture();
  fs.writeFileSync(
    path.join(fixture.repoRoot, ".codex/memories/topico/topico.md"),
    "# Tópico\n\n[Ausente](../../../docs/AUSENTE.md)\n",
  );

  const result = checkPublicMemory(fixture);
  assert.ok(result.errors.some((error) => error.includes("broken or untracked relative link")));
});

test("an untracked file cannot satisfy the public memory graph", () => {
  const fixture = createFixture();
  const untracked = ".codex/memories/untracked/untracked-topic.md";
  const absolute = path.join(fixture.repoRoot, untracked);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, "# Present only in the worktree\n");
  fs.appendFileSync(
    path.join(fixture.repoRoot, "MEMORY.md"),
    `\n- [Untracked](.codex/memories/untracked/untracked-topic.md)\n`,
  );

  const result = checkPublicMemory(fixture);
  assert.ok(result.errors.some((error) => error.includes("broken or untracked relative link")));
  assert.ok(result.errors.some((error) => error.includes("points to unknown thematic memory")));
});

test("rejects tracked private runtime paths while allowing public Codex memory", () => {
  const fixture = createFixture();
  fixture.trackedFiles.push(
    ".agent-history/turns.jsonl",
    ".codex/hooks.json",
    ".codex/session-state.json",
  );

  const result = checkPublicMemory(fixture);
  assert.ok(result.errors.some((error) => error.startsWith(".agent-history/turns.jsonl:")));
  assert.ok(result.errors.every((error) => !error.startsWith(".codex/hooks.json:")));
  assert.ok(result.errors.some((error) => error.startsWith(".codex/session-state.json:")));
});

test("reports private-data patterns without echoing their value", () => {
  const fixture = createFixture();
  const privateValue = ["192", "168", "44", "10"].join(".");
  fs.writeFileSync(
    path.join(fixture.repoRoot, ".codex/memories/topico/topico.md"),
    `# Tópico\n\nEndpoint privado: ${privateValue}\n`,
  );

  const result = checkPublicMemory(fixture);
  assert.ok(result.errors.some((error) => error.includes("prohibited private-data pattern: private-ipv4")));
  assert.ok(result.errors.every((error) => !error.includes(privateValue)));
});

test("reports duplicate instruction headings and the obsolete memory glob", () => {
  const fixture = createFixture();
  fs.writeFileSync(
    path.join(fixture.repoRoot, "scripts/weekly-docs-review.prompt.md"),
    `# Revisão

## Memória versionada dos agentes

memories/**

## Memória versionada dos agentes
`,
  );

  const result = checkPublicMemory(fixture);
  assert.ok(result.errors.some((error) => error.includes("duplicate level-two heading")));
  assert.ok(result.errors.some((error) => error.includes("canonical memory glob is missing")));
  assert.ok(result.errors.some((error) => error.includes("obsolete memory glob")));
});
