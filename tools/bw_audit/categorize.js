#!/usr/bin/env node
// Propõe pastas para itens do Bitwarden com base em regras de nome/URL.
// MODO PADRÃO: dry-run — só imprime o plano, não altera nada.
// Uso:
//   node categorize.js            -> imprime plano (contagens + itens por pasta)
//   node categorize.js --apply    -> aplica de fato (cria pastas e move itens)
const { execSync } = require("child_process");
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

const RULES = [
  ["Trabalho (Ambev)", /ambev|ab-inbev|bees|databricks|astronomer\.io|cloudera|atlassian|jira|confluence|datadog|adb-\d|azuredatabricks|gsti\.itau|webassessor/i],
  ["Ferramentas / Cloud", /\baws\b|console\.aws|portal\.aws\.amazon|github\.com|postman|docusign|teamviewer|anydesk|miro\.com|mobaxterm|ibm\.com|cloud\.ibm/i],
  ["Financeiro", /caixa\.gov|caixa\b|banestes|itau|nubank|\bc6\b|\bxp[i.]|tesourodireto|picpay|libertyseguros|portoseguro|bradesco|cartaobom|inter\.co|santander|sicredi|sicoob/i],
  ["Compras Online", /amazon|americanas|submarino|casasbahia|aliexpress|shoptime|magalu|extra\.com|dafiti|kalunga|elo7|decathlon|petz|mercadolivre|mercadopago|pontofrio|gocase|lojamundogeek|drogaria(?!s)|olx\.com/i],
  ["Streaming e Redes Sociais", /netflix|hbo|globoplay|spotify|discord|steam|bsky\.app|instagram|facebook|twitter|\bx\.com\b|youtube|grooveshark|filmow|prezi|linkedin/i],
  ["Educação", /ufabc|moodle|alura|englishfile|culturainglesa|usp\.br|academico|edupass|awsacademy/i],
  ["Governo e Documentos", /gov\.br|receita\.fazenda|procon|anatel|detran|acessocidadao|sso\.acesso/i],
  ["Casa Inteligente / IoT", /home ?assistant|nabu\.casa|foxess|omada|nvr intelbras|icsee|mercusys|localtuya|moni mobile|192\.168\.|magic home/i],
  ["Viagens", /latam|\btam\.com|booking\.com|airbnb|amtrak|\bdhl\b|correios|clientes\.ups|american ?airlines|eucatur|autoviacao|123milhas|bahn\.de|hilton|ingresso/i],
  ["Saúde", /drogasil|drogariasaopaulo|drogariaspacheco|dasa\.com|odontoprev|amedigital|dograsil/i],
  ["Assinaturas e Utilidades", /edponline|edp\.pt|vivo\.com|netcombo|tim\.com|claro|oi\.com|starlink/i],
];

function classify(item) {
  const hay = [item.name, item.login?.uris?.map((u) => u.uri).join(" ") || ""].join(" ");
  for (const [folder, re] of RULES) if (re.test(hay)) return folder;
  return null; // fica sem categoria automática -> revisão manual
}

const folders = JSON.parse(bw("list folders"));
const folderIdByName = new Map(folders.map((f) => [f.name, f.id]));
const items = JSON.parse(bw("list items"));

const plan = new Map(); // folderName -> [items]
let uncategorized = 0;
for (const it of items) {
  if (it.type !== 1) continue; // só logins
  const currentFolder = it.folderId ? folders.find((f) => f.id === it.folderId)?.name : "No Folder";
  if (currentFolder && currentFolder !== "No Folder") continue; // já organizado manualmente, não mexe
  const target = classify(it);
  if (!target) {
    uncategorized++;
    continue;
  }
  if (!plan.has(target)) plan.set(target, []);
  plan.get(target).push(it);
}

console.log(`\n=== Plano de organização (${APPLY ? "APLICANDO" : "DRY-RUN"}) ===`);
for (const [folder, list] of plan) {
  console.log(`\n${folder}: ${list.length} itens`);
  for (const it of list.slice(0, 8)) console.log(`  - ${it.name}`);
  if (list.length > 8) console.log(`  ... e mais ${list.length - 8}`);
}
console.log(`\nSem categoria automática (ficam em No Folder para revisão manual): ${uncategorized}`);

if (!APPLY) {
  console.log("\nNenhuma alteração feita. Rode com --apply para executar este plano.\n");
  process.exit(0);
}

console.log("\nAplicando...");
for (const [folderName, list] of plan) {
  let folderId = folderIdByName.get(folderName);
  if (!folderId) {
    const encoded = bw(`encode`); // placeholder, real create below
  }
  if (!folderId) {
    const created = JSON.parse(
      execSync(`echo '${JSON.stringify({ name: folderName })}' | "${BW}" encode | "${BW}" create folder --session "${S}"`, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 10,
      })
    );
    folderId = created.id;
    folderIdByName.set(folderName, folderId);
    console.log(`Pasta criada: ${folderName} (${folderId})`);
  }
  for (const it of list) {
    const full = JSON.parse(bw(`get item ${it.id}`));
    full.folderId = folderId;
    const encoded = execSync(`echo '${JSON.stringify(full).replace(/'/g, "'\\''")}' | "${BW}" encode`, {
      encoding: "utf8",
    }).trim();
    execSync(`"${BW}" edit item ${it.id} ${encoded} --session "${S}"`, { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
  }
  console.log(`  -> ${list.length} itens movidos para "${folderName}"`);
}
console.log("\nConcluído.\n");
