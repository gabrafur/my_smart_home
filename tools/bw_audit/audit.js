#!/usr/bin/env node
// Audita o vault do Bitwarden: senhas fracas, reutilizadas, antigas e itens sem TOTP.
// Uso: BW_SESSION=<session> node audit.js
// Não escreve nada no vault — só lê e imprime um relatório local.

const { execSync } = require("child_process");
const path = require("path");

const BW = path.join(__dirname, "node_modules", ".bin", "bw");

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 });
}

if (!process.env.BW_SESSION) {
  console.error("Defina BW_SESSION primeiro (saída de `bw unlock`).");
  process.exit(1);
}

let items;
try {
  items = JSON.parse(sh(`"${BW}" list items --session "${process.env.BW_SESSION}"`));
} catch (e) {
  console.error("Falha ao listar itens. Sessão válida? Erro:", e.message);
  process.exit(1);
}

const logins = items.filter((i) => i.type === 1 && i.login && i.login.password);

// --- Reuso de senha ---
const byPassword = new Map();
for (const it of logins) {
  const pw = it.login.password;
  if (!byPassword.has(pw)) byPassword.set(pw, []);
  byPassword.get(pw).push(it.name);
}
const reused = [...byPassword.entries()].filter(([, names]) => names.length > 1);

// --- Senhas fracas (heurística simples) ---
function weakness(pw) {
  const issues = [];
  if (pw.length < 12) issues.push("curta (<12)");
  if (!/[A-Z]/.test(pw)) issues.push("sem maiúscula");
  if (!/[a-z]/.test(pw)) issues.push("sem minúscula");
  if (!/[0-9]/.test(pw)) issues.push("sem número");
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push("sem símbolo");
  return issues;
}
const weak = logins
  .map((it) => ({ name: it.name, issues: weakness(it.login.password) }))
  .filter((r) => r.issues.length > 0);

// --- Antigas (sem alterar passwordRevisionDate há mais de 1 ano) ---
const oneYearAgo = new Date();
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
const old = logins.filter((it) => {
  const rev = it.passwordHistory && it.revisionDate ? new Date(it.revisionDate) : null;
  return rev && rev < oneYearAgo;
});

// --- Sem TOTP configurado ---
const noTotp = logins.filter((it) => !it.login.totp);

console.log(`\n=== Auditoria Bitwarden (${logins.length} itens de login) ===\n`);

console.log(`Senhas reutilizadas (${reused.length} grupos):`);
for (const [, names] of reused) console.log(`  - usada em: ${names.join(", ")}`);

console.log(`\nSenhas fracas (${weak.length}):`);
for (const r of weak) console.log(`  - ${r.name}: ${r.issues.join(", ")}`);

console.log(`\nSem alteração há mais de 1 ano (${old.length}):`);
for (const it of old) console.log(`  - ${it.name} (última alteração: ${it.revisionDate})`);

console.log(`\nSem TOTP/2FA configurado no Bitwarden (${noTotp.length}):`);
for (const it of noTotp) console.log(`  - ${it.name}`);

console.log("\nNenhuma senha foi modificada. Isto é apenas um relatório.\n");
