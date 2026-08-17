#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const criticalChunks = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

export function stripPngMetadata(buffer) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("invalid PNG signature");
  const chunks = [signature];
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error("truncated PNG chunk");
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("truncated PNG payload");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (criticalChunks.has(type)) chunks.push(buffer.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(chunks);
}

function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error("usage: node scripts/strip-png-metadata.mjs <png>");
  const output = stripPngMetadata(fs.readFileSync(filename));
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.tmp`);
  fs.writeFileSync(temporary, output, { mode: 0o644 });
  fs.renameSync(temporary, filename);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
