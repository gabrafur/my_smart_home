import fs from "node:fs";

const requiredFiles = ["flows.json", "package.json"];
const optionalFiles = ["flows_cred.json"];
const files = [
  ...requiredFiles,
  ...optionalFiles.filter((file) => fs.existsSync(new URL(`../${file}`, import.meta.url))),
];

for (const file of files) {
  JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
}

console.log(`Valid JSON: ${files.join(", ")}`);
