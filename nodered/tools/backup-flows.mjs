import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const backupDir = path.join(root, "backups", "codex-flows");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

fs.mkdirSync(backupDir, { recursive: true });

const files = ["flows.json", "flows_cred.json"].filter((file) => fs.existsSync(path.join(root, file)));

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(backupDir, `${stamp}-${file}`));
}

console.log(`Backup created: ${files.map((file) => `${backupDir}/${stamp}-${file}`).join(", ")}`);
