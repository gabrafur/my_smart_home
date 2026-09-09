#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(fs.readFileSync(path.join(here, "..", "flows.json"), "utf8"));

function closingParen(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(char)) quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function argumentsAtTopLevel(source) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(char)) quote = char;
    else if (["(", "[", "{"].includes(char)) depth += 1;
    else if ([")", "]", "}"].includes(char)) depth -= 1;
    else if (char === "," && depth === 0) return true;
  }
  return false;
}

const missingMessage = [];
for (const node of flows.filter((item) => item.type === "function" && typeof item.func === "string")) {
  let cursor = 0;
  while (cursor < node.func.length) {
    const found = node.func.indexOf("node.error(", cursor);
    if (found < 0) break;
    const open = found + "node.error".length;
    const close = closingParen(node.func, open);
    assert.notEqual(close, -1, `node.error sem fechamento em ${node.id}`);
    const args = node.func.slice(open + 1, close);
    if (!argumentsAtTopLevel(args)) missingMessage.push(`${node.id} (${node.name || node.type})`);
    cursor = close + 1;
  }
}

assert.deepEqual(
  missingMessage,
  [],
  "todo node.error de Function deve receber msg para alcançar o catch/global observer",
);
console.log("Node-RED function errors route through catch/global observer.");
