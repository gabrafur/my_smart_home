#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseAllDocuments } = require("../validation/node_modules/yaml");

function trackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "buffer",
  });
  if (result.status !== 0) throw new Error("git ls-files failed");
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

export function checkStructuredFiles({ root = repoRoot, files = trackedFiles(root), format = "all" } = {}) {
  const errors = [];
  let jsonFiles = 0;
  let yamlFiles = 0;
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (extension === ".json" && format !== "yaml") {
      jsonFiles += 1;
      try {
        JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      } catch (error) {
        errors.push(`${file}: invalid JSON: ${error.message}`);
      }
    }
    if ([".yaml", ".yml"].includes(extension) && format !== "json") {
      yamlFiles += 1;
      const documents = parseAllDocuments(fs.readFileSync(path.join(root, file), "utf8"), {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
      });
      for (const document of documents) {
        for (const error of document.errors) errors.push(`${file}: invalid YAML: ${error.message}`);
      }
    }
  }
  return { errors, jsonFiles, yamlFiles };
}

function main() {
  const format = process.argv[2] ?? "all";
  if (!["all", "json", "yaml"].includes(format)) {
    console.error("usage: structured-files-check.mjs [all|json|yaml]");
    process.exit(2);
  }
  const result = checkStructuredFiles({ format });
  if (result.errors.length) {
    console.error(`Structured file check failed (${result.errors.length} issue(s)):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Structured file check passed: ${result.jsonFiles} JSON, ${result.yamlFiles} YAML.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
