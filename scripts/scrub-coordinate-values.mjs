#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const valuesFile = process.argv[2];
if (!valuesFile) throw new Error("uso: scrub-coordinate-values.mjs <arquivo-de-valores>");

const values = fs
  .readFileSync(valuesFile, "utf8")
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);

function visit(entry) {
  const stat = fs.lstatSync(entry);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (path.basename(entry) === ".git") return;
    for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    return;
  }
  if (!stat.isFile()) return;

  const input = fs.readFileSync(entry);
  if (input.includes(0)) return;
  let text = input.toString("utf8");
  let changed = false;
  for (const value of values) {
    if (!text.includes(value)) continue;
    text = text.split(value).join(value.includes("°") ? "[REDACTED_COORDINATE]" : "0.0");
    changed = true;
  }
  if (changed) fs.writeFileSync(entry, text);
}

visit(process.cwd());
