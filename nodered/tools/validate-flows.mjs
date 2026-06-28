import fs from "node:fs";

const files = ["flows.json", "flows_cred.json", "package.json"];

for (const file of files) {
  JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
}

console.log(`Valid JSON: ${files.join(", ")}`);
