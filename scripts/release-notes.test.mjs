import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { releaseNotes } from "./release-notes.mjs";

const changelog = "# Changelog\n\n## Não lançado / Unreleased\n\n- next\n\n## v2026.11.0 — 2026-11-22\n\n### Added\n\n- feature\n\nFixes: 3.\n\n## 2026-10\n\n- older\n";

test("extracts only the section of the requested tag", () => {
  const notes = releaseNotes(changelog, "v2026.11.0");
  assert.match(notes, /- feature/);
  assert.match(notes, /Fixes: 3\./);
  assert.doesNotMatch(notes, /older|next/);
});

test("rejects malformed tags, missing and empty sections", () => {
  assert.throws(() => releaseNotes(changelog, "2026.11.0"), /invalid release tag/);
  assert.throws(() => releaseNotes(changelog, "v2026.13.0"), /invalid release tag/);
  assert.throws(() => releaseNotes(changelog, "v2026.12.0"), /no section/);
  assert.throws(() => releaseNotes("## v2026.12.0\n\n## 2026-10\n", "v2026.12.0"), /empty/);
});

test("the repository changelog has a section for every tag format it documents", () => {
  const real = fs.readFileSync(new URL("../docs/CHANGELOG.md", import.meta.url), "utf8");
  for (const match of real.matchAll(/^## (v\d{4}\.\d{2}\.\d+)\b/gm)) {
    assert.ok(releaseNotes(real, match[1]).length > 40, match[1]);
  }
});
