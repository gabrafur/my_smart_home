#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_REPORTED_DIFFERENCES = 50;

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJsonScalar(before, after) {
  return before === after;
}

function approvedVisualField(beforeNode, afterNode, key) {
  if (!isJsonObject(beforeNode) || !isJsonObject(afterNode)) return false;
  if (beforeNode.id !== afterNode.id || beforeNode.type !== afterNode.type) return false;
  if (!Object.hasOwn(beforeNode, key) || !Object.hasOwn(afterNode, key)) return false;
  if (!Number.isFinite(beforeNode[key]) || !Number.isFinite(afterNode[key])) return false;
  if (typeof beforeNode.z !== "string" || beforeNode.z !== afterNode.z) return false;

  if (key === "x" || key === "y") {
    return typeof beforeNode.id === "string" && typeof beforeNode.type === "string";
  }
  return (key === "w" || key === "h") && beforeNode.type === "group";
}

function formatValue(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return String(value);
  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
}

export function compareLayoutOnly(before, after) {
  const functionalDifferences = [];
  const visualChanges = [];

  function recordDifference(pathName, beforeValue, afterValue, reason = "value changed") {
    functionalDifferences.push({
      path: pathName,
      before: beforeValue,
      after: afterValue,
      reason,
    });
  }

  function compareValue(beforeValue, afterValue, pathName, topLevelNode = null) {
    if (Array.isArray(beforeValue) || Array.isArray(afterValue)) {
      if (!Array.isArray(beforeValue) || !Array.isArray(afterValue)) {
        recordDifference(pathName, beforeValue, afterValue, "type changed");
        return;
      }
      if (beforeValue.length !== afterValue.length) {
        recordDifference(`${pathName}.length`, beforeValue.length, afterValue.length, "array length changed");
      }
      const commonLength = Math.min(beforeValue.length, afterValue.length);
      for (let index = 0; index < commonLength; index += 1) {
        const itemBefore = beforeValue[index];
        const itemAfter = afterValue[index];
        const nextTopLevelNode = pathName === "$" ? itemBefore : topLevelNode;
        compareValue(itemBefore, itemAfter, `${pathName}[${index}]`, nextTopLevelNode);
      }
      return;
    }

    if (isJsonObject(beforeValue) || isJsonObject(afterValue)) {
      if (!isJsonObject(beforeValue) || !isJsonObject(afterValue)) {
        recordDifference(pathName, beforeValue, afterValue, "type changed");
        return;
      }
      const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
      for (const key of [...keys].sort()) {
        const childPath = `${pathName}.${key}`;
        if (!Object.hasOwn(beforeValue, key) || !Object.hasOwn(afterValue, key)) {
          recordDifference(childPath, beforeValue[key], afterValue[key], "property added or removed");
          continue;
        }
        if (
          beforeValue === topLevelNode &&
          approvedVisualField(beforeValue, afterValue, key)
        ) {
          if (!sameJsonScalar(beforeValue[key], afterValue[key])) {
            visualChanges.push({
              id: beforeValue.id,
              type: beforeValue.type,
              property: key,
              before: beforeValue[key],
              after: afterValue[key],
            });
          }
          continue;
        }
        compareValue(beforeValue[key], afterValue[key], childPath, topLevelNode);
      }
      return;
    }

    if (!sameJsonScalar(beforeValue, afterValue)) {
      recordDifference(pathName, beforeValue, afterValue);
    }
  }

  compareValue(before, after, "$", null);
  return { functionalDifferences, visualChanges };
}

export function renderComparison(result) {
  if (result.functionalDifferences.length > 0) {
    const lines = [
      "FAIL:",
      `Functional change detected (${result.functionalDifferences.length} difference(s)).`,
    ];
    for (const difference of result.functionalDifferences.slice(0, MAX_REPORTED_DIFFERENCES)) {
      lines.push(
        `- ${difference.path}: ${difference.reason}; ` +
        `${formatValue(difference.before)} -> ${formatValue(difference.after)}`,
      );
    }
    if (result.functionalDifferences.length > MAX_REPORTED_DIFFERENCES) {
      lines.push(`- ... ${result.functionalDifferences.length - MAX_REPORTED_DIFFERENCES} additional difference(s) omitted`);
    }
    return { ok: false, text: lines.join("\n") };
  }

  const byProperty = new Map();
  const changedNodes = new Set();
  for (const change of result.visualChanges) {
    changedNodes.add(change.id);
    byProperty.set(change.property, (byProperty.get(change.property) ?? 0) + 1);
  }
  const summary = [...byProperty.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, count]) => `${property}=${count}`)
    .join(", ") || "no coordinate changes";
  return {
    ok: true,
    text: [
      "PASS:",
      "Only approved visual properties changed.",
      `Visual changes: ${result.visualChanges.length} field(s) across ${changedNodes.size} object(s) (${summary}).`,
    ].join("\n"),
  };
}

function readJson(target) {
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${target}: expected a top-level JSON array`);
  return parsed;
}

function main(argv) {
  if (argv.length !== 2) {
    console.error("Usage: node nodered/tools/validate-layout-only.mjs BEFORE.json AFTER.json");
    return 2;
  }
  const [beforePath, afterPath] = argv.map((target) => path.resolve(target));
  const rendered = renderComparison(compareLayoutOnly(readJson(beforePath), readJson(afterPath)));
  const output = rendered.ok ? console.log : console.error;
  output(rendered.text);
  return rendered.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL:\n${error.message}`);
    process.exitCode = 2;
  }
}
