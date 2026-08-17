import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkAssets } from "./assets-check.mjs";
import { stripPngMetadata } from "./strip-png-metadata.mjs";

function png({ width = 1280, height = 640, colorType = 2, ancillary = false } = {}) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const chunk = (type, payload) => {
    const result = Buffer.alloc(12 + payload.length);
    result.writeUInt32BE(payload.length, 0);
    result.write(type, 4, 4, "ascii");
    payload.copy(result, 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const chunks = [signature, chunk("IHDR", header)];
  if (ancillary) chunks.push(chunk("tEXt", Buffer.from("private=metadata")));
  chunks.push(chunk("IDAT", Buffer.alloc(1)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function fixture(t, pngData = png()) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asset-check-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const files = {
    "docs/assets/smart-home-architecture.mmd": "Public, reviewable repository\nPrivate, never committed\nExplicit recovery path\nHome Assistant\nNode-RED\n",
    "docs/assets/smart-home-architecture.svg": "<svg>Home Assistant Node-RED Optional agent bridge Private bindings and secrets Encrypted private restore bundle</svg>",
    "docs/assets/github-social-preview.svg": "<svg width=\"1280\" height=\"640\">Self-hosted Smart Home Platform Security · Observability · Recovery · Local AI</svg>",
  };
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  const image = "docs/assets/github-social-preview.png";
  fs.writeFileSync(path.join(repoRoot, image), pngData);
  return { repoRoot, trackedFiles: [...Object.keys(files), image] };
}

test("accepts reproducible architecture and a metadata-free RGB social preview", (t) => {
  assert.deepEqual(checkAssets(fixture(t)).errors, []);
});

test("rejects social-preview dimensions, alpha, and metadata", (t) => {
  const result = checkAssets(fixture(t, png({ width: 1200, colorType: 6, ancillary: true })));
  assert.ok(result.errors.some((error) => error.includes("expected 1280x640")));
  assert.ok(result.errors.some((error) => error.includes("without alpha")));
  assert.ok(result.errors.some((error) => error.includes("ancillary")));
});

test("metadata stripping keeps only critical PNG chunks", () => {
  const stripped = stripPngMetadata(png({ ancillary: true }));
  assert.equal(stripped.includes(Buffer.from("tEXt")), false);
  assert.equal(stripped.includes(Buffer.from("IHDR")), true);
});
