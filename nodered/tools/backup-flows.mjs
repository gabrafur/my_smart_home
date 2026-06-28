import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const backupDir = path.join(root, "backups", "codex-flows");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

fs.mkdirSync(backupDir, { recursive: true });

for (const file of ["flows.json", "flows_cred.json"]) {
  fs.copyFileSync(path.join(root, file), path.join(backupDir, `${stamp}-${file}`));
}

console.log(`Backup created: ${backupDir}/${stamp}-*.json`);
