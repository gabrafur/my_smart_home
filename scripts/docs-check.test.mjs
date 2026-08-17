import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDocumentation } from "./docs-check.mjs";

function fixture(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docs-check-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const files = {
    "README.md": "# Projeto\n\n[English](README.en.md)\n\n[Docs](docs/README.md)\n",
    "README.en.md": "# Project\n\n[Português](README.md)\n\n[Docs](docs/README.en.md)\n",
    "docs/README.md": "# Documentação\n\n[English](README.en.md)\n\n[Guia](GUIDE.md#seção-válida)\n",
    "docs/README.en.md": "# Documentation\n\n[Português](README.md)\n\n[Guide](GUIDE.en.md#valid-section)\n",
    "docs/GUIDE.md": "# Guia\n\n[English](GUIDE.en.md)\n\n## Seção válida\n",
    "docs/GUIDE.en.md": "# Guide\n\n[Português](GUIDE.md)\n\n## Valid section\n",
    "docs/i18n-manifest.json": JSON.stringify({
      schema_version: 2,
      primary_language: "pt-BR",
      areas: ["overview", "getting-started"],
      strategies: ["full pair", "summary pair", "third-party/not-translated", "archived"],
      documents: [
        { area: "overview", strategy: "full pair", pt: "README.md", en: "README.en.md" },
        { area: "overview", strategy: "full pair", pt: "docs/README.md", en: "docs/README.en.md" },
        { area: "getting-started", strategy: "full pair", pt: "docs/GUIDE.md", en: "docs/GUIDE.en.md" },
      ],
    }),
    "docker-compose.yml": "services:\n  core:\n    image: example.invalid/core\n",
    "Makefile": "validate-public:\n\t@true\n",
  };
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return { repoRoot, trackedFiles: Object.keys(files) };
}

test("accepts a recursive, bilingual and reachable documentation graph", (t) => {
  const input = fixture(t);
  const result = checkDocumentation(input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.markdownFiles, 6);
  assert.equal(result.stats.pairs, 3);
});

test("rejects broken anchors and orphaned recursive documents", (t) => {
  const input = fixture(t);
  fs.appendFileSync(path.join(input.repoRoot, "docs/README.md"), "\n[Broken](GUIDE.md#missing)\n");
  fs.writeFileSync(path.join(input.repoRoot, "docs/ORPHAN.md"), "# Órfão\n");
  input.trackedFiles.push("docs/ORPHAN.md");
  const result = checkDocumentation(input);
  assert.ok(result.errors.some((error) => error.includes("missing Markdown anchor")));
  assert.ok(result.errors.some((error) => error.includes("docs/ORPHAN.md: orphaned")));
});

test("an untracked link target cannot satisfy public documentation", (t) => {
  const input = fixture(t);
  fs.writeFileSync(path.join(input.repoRoot, "docs/UNTRACKED.md"), "# Untracked\n");
  fs.appendFileSync(path.join(input.repoRoot, "docs/README.md"), "\n[Untracked](UNTRACKED.md)\n");
  const result = checkDocumentation(input);
  assert.ok(result.errors.some((error) => error.includes("broken or untracked relative link")));
});

test("requires every public human document to declare an i18n strategy", (t) => {
  const input = fixture(t);
  fs.writeFileSync(path.join(input.repoRoot, "docs/UNCLASSIFIED.md"), "# Unclassified\n");
  fs.appendFileSync(path.join(input.repoRoot, "docs/README.md"), "\n[New](UNCLASSIFIED.md)\n");
  input.trackedFiles.push("docs/UNCLASSIFIED.md");
  const result = checkDocumentation(input);
  assert.ok(result.errors.some((error) => error.includes("human documentation is not classified")));
});

test("validates cited Make and npm commands", (t) => {
  const input = fixture(t);
  fs.appendFileSync(
    path.join(input.repoRoot, "docs/GUIDE.md"),
    "\nRun `make missing-target` and `npm --prefix tool run missing`.\n",
  );
  const result = checkDocumentation(input);
  assert.ok(result.errors.some((error) => error.includes("unknown Make target")));
  assert.ok(result.errors.some((error) => error.includes("unknown npm package prefix")));
});
