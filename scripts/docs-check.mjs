import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(repoRoot, "docs");
const markdownFiles = [
  path.join(repoRoot, "README.md"),
  path.join(repoRoot, "README.en.md"),
  ...fs.readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(docsDir, name)),
];

const requiredPairs = [
  ["README.md", "README.en.md"],
  ["docs/README.md", "docs/README.en.md"],
  ["docs/CONTAINERS.md", "docs/CONTAINERS.en.md"],
  ["docs/INSTALACAO_RESTAURACAO_SMART_HOME.md", "docs/INSTALLATION_RESTORE.en.md"],
  ["docs/REVISAO_DOCUMENTACAO_SEMANAL.md", "docs/WEEKLY_DOCUMENTATION_REVIEW.en.md"],
  ["docs/ZIGBEE_HEALTH_NOTIFICATIONS.md", "docs/ZIGBEE_HEALTH_NOTIFICATIONS.en.md"],
  ["docs/PRIVACY_MODEL.md", "docs/PRIVACY_MODEL.en.md"],
  ["docs/PUBLIC_PRIVATE_BOUNDARY.md", "docs/PUBLIC_PRIVATE_BOUNDARY.en.md"],
  ["docs/RESTORE_CONTRACT.md", "docs/RESTORE_CONTRACT.en.md"],
  ["docs/BOOTSTRAP_DEMO.md", "docs/BOOTSTRAP_DEMO.en.md"],
];

const errors = [];
const relative = (file) => path.relative(repoRoot, file);

for (const [pt, en] of requiredPairs) {
  for (const file of [pt, en]) {
    if (!fs.existsSync(path.join(repoRoot, file))) {
      errors.push(`missing required bilingual document: ${file}`);
    }
  }
}

for (const file of markdownFiles) {
  const content = fs.readFileSync(file, "utf8");

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    const pathPart = target.split("#", 1)[0];
    if (!pathPart || /^[a-z][a-z0-9+.-]*:/i.test(pathPart)) {
      continue;
    }
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(pathPart));
    if (!fs.existsSync(resolved)) {
      errors.push(`${relative(file)}: broken relative link: ${target}`);
    }
  }

  for (const match of content.matchAll(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g)) {
    errors.push(`${relative(file)}: private IPv4 literal must be a placeholder: ${match[0]}`);
  }

  for (const match of content.matchAll(/-?\d{1,3}\.\d{6,}/g)) {
    errors.push(`${relative(file)}: precise coordinate-like value is not allowed: ${match[0]}`);
  }

  for (const match of content.matchAll(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g)) {
    if (match[0] !== "AA:AA:AA:AA:AA:AA") {
      errors.push(`${relative(file)}: MAC address must be a placeholder: ${match[0]}`);
    }
  }
}

const compose = fs.readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
const servicesStart = compose.search(/^services:[ \t]*$/m);
if (servicesStart === -1) {
  errors.push("docker-compose.yml: missing top-level services block");
}
const afterServices = servicesStart === -1 ? "" : compose.slice(servicesStart).replace(/^services:[ \t]*\n/, "");
const nextTopLevel = afterServices.search(/^[a-zA-Z][a-zA-Z0-9_-]*:[ \t]*$/m);
const servicesBlock = nextTopLevel === -1 ? afterServices : afterServices.slice(0, nextTopLevel);
const services = [...servicesBlock.matchAll(/^ {2}([a-zA-Z0-9_-]+):[ \t]*$/gm)].map((match) => match[1]);
for (const guide of ["docs/CONTAINERS.md", "docs/CONTAINERS.en.md"]) {
  const content = fs.readFileSync(path.join(repoRoot, guide), "utf8");
  for (const service of services) {
    if (!content.includes(`\`${service}\``)) {
      errors.push(`${guide}: Compose service is not documented: ${service}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Documentation check failed (${errors.length} issue(s)):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Documentation check passed: ${markdownFiles.length} Markdown files, ${services.length} Compose services.`);
