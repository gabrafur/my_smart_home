#!/usr/bin/env node
// Cria pastas "Senhas para Trocar" (itens com senha reutilizada) e "Valéria"
// (itens cujo nome menciona ela) e move os itens correspondentes.
// Uso: node make_folders.js            -> dry-run (mostra o que faria)
//      node make_folders.js --apply    -> aplica de fato
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const BW = path.join(__dirname, "node_modules", ".bin", "bw");
const APPLY = process.argv.includes("--apply");

if (!process.env.BW_SESSION) {
  console.error("Defina BW_SESSION.");
  process.exit(1);
}
const S = process.env.BW_SESSION;

function bw(cmd) {
  return execSync(`"${BW}" ${cmd} --session "${S}"`, { encoding: "utf8", maxBuffer: 1024 * 1024 * 80 });
}

const folders = JSON.parse(bw("list folders"));
const items = JSON.parse(bw("list items"));
const logins = items.filter((i) => i.type === 1 && i.login && i.login.password);

// Grupos de senha reutilizada
const byPassword = new Map();
for (const it of logins) {
  const pw = it.login.password;
  if (!byPassword.has(pw)) byPassword.set(pw, []);
  byPassword.get(pw).push(it);
}
const toChange = [];
for (const [, list] of byPassword) if (list.length > 1) toChange.push(...list);

const VALERIA_RE = /val[eé]ria/i;
const valeriaItems = logins.filter((it) => VALERIA_RE.test(it.name));

// Evita duplicar um item nas duas pastas: Valéria tem prioridade.
const valeriaIds = new Set(valeriaItems.map((i) => i.id));
const toChangeFiltered = toChange.filter((it) => !valeriaIds.has(it.id));

console.log(`\n=== Plano (${APPLY ? "APLICANDO" : "DRY-RUN"}) ===`);
console.log(`\nSenhas para Trocar: ${toChangeFiltered.length} itens`);
for (const it of toChangeFiltered) console.log(`  - ${it.name}`);
console.log(`\nValéria: ${valeriaItems.length} itens`);
for (const it of valeriaItems) console.log(`  - ${it.name}`);

if (!APPLY) {
  console.log("\nNenhuma alteração feita. Rode com --apply para executar.\n");
  process.exit(0);
}

function encodeViaFile(obj) {
  const tmp = path.join(os.tmpdir(), `bw_${process.pid}_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try {
    return execFileSync(BW, ["encode"], {
      input: fs.readFileSync(tmp),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
    }).trim();
  } finally {
    fs.unlinkSync(tmp);
  }
}

function ensureFolder(name) {
  let f = folders.find((f) => f.name === name);
  if (f) return f.id;
  const encoded = encodeViaFile({ name });
  const created = JSON.parse(
    execFileSync(BW, ["create", "folder", encoded, "--session", S], { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 })
  );
  folders.push(created);
  console.log(`Pasta criada: ${name} (${created.id})`);
  return created.id;
}

function moveItem(it, folderId) {
  const full = JSON.parse(
    execFileSync(BW, ["get", "item", it.id, "--session", S], { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 })
  );
  full.folderId = folderId;
  const encoded = encodeViaFile(full);
  execFileSync(BW, ["edit", "item", it.id, encoded, "--session", S], { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
}

const toChangeFolderId = ensureFolder("Senhas para Trocar");
const valeriaFolderId = ensureFolder("Valéria");

console.log("\nMovendo itens de Valéria...");
for (const it of valeriaItems) moveItem(it, valeriaFolderId);
console.log(`  -> ${valeriaItems.length} itens movidos.`);

console.log("\nMovendo itens de Senhas para Trocar...");
for (const it of toChangeFiltered) moveItem(it, toChangeFolderId);
console.log(`  -> ${toChangeFiltered.length} itens movidos.`);

console.log("\nConcluído.\n");
