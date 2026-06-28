import fs from "node:fs";

const flows = JSON.parse(
  fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"),
);

const tabs = new Map(
  flows.filter((node) => node.type === "tab").map((node) => [node.id, node.label]),
);

for (const [id, label] of tabs) {
  console.log(`[${label}]`);
  for (const node of flows.filter((item) => item.z === id)) {
    console.log(`${node.name || node.label || "(sem nome)"}\t${node.type}`);
  }
  console.log("");
}

console.log(`Total nodes: ${flows.length}`);
