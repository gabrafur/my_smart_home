#!/usr/bin/env node

import fs from "node:fs";
import { validateFlowLayout } from "./flow-layout-validator.mjs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const issues = validateFlowLayout(flows);

if (issues.length > 0) {
  console.error("Node-RED canvas validation failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

const canvases = flows.filter((node) => node.type === "tab" || node.type === "subflow").length;
console.log(`Node-RED canvas layout valid: ${canvases} tabs/subflows without overlapping nodes or groups.`);
