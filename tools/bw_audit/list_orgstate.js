#!/usr/bin/env node
// Lê itens do Bitwarden e imprime só nome/pasta/tipo — nunca senha, nunca em disco.
const { execSync } = require("child_process");
const path = require("path");
const BW = path.join(__dirname, "node_modules", ".bin", "bw");

if (!process.env.BW_SESSION) {
  console.error("Defina BW_SESSION.");
  process.exit(1);
}

const folders = JSON.parse(
  execSync(`"${BW}" list folders --session "${process.env.BW_SESSION}"`, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 })
);
const items = JSON.parse(
  execSync(`"${BW}" list items --session "${process.env.BW_SESSION}"`, { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 })
);

const folderName = new Map(folders.map((f) => [f.id, f.name]));
folderName.set(null, "No Folder");

const byFolder = new Map();
for (const it of items) {
  const fname = folderName.get(it.folderId) || "No Folder";
  if (!byFolder.has(fname)) byFolder.set(fname, []);
  byFolder.get(fname).push({
    name: it.name,
    type: it.type, // 1=login,2=note,3=card,4=identity
    url: it.login && it.login.uris && it.login.uris[0] ? it.login.uris[0].uri : null,
  });
}

for (const [fname, list] of byFolder) {
  console.log(`\n## ${fname} (${list.length})`);
  for (const it of list) {
    console.log(`  - ${it.name}${it.url ? "  [" + it.url + "]" : ""}`);
  }
}
