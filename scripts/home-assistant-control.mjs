#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ALLOWED_ACTIONS = new Set(["get", "turn-on", "turn-off", "toggle"]);
const ALLOWED_DOMAINS = new Set([
  "light",
  "switch",
  "fan",
  "cover",
  "media_player",
  "vacuum",
  "input_boolean",
]);
const INFRASTRUCTURE_PATTERN = /(?:^|[_.\s-])(?:backup|codex|cpu|disk|docker|host|homeassistant|infrastructure|infraestrutura|internet|memory|mosquitto|node_?red|ollama|portainer|raspberry|rtx|storage|system|update|zigbee2mqtt)(?:$|[_.\s-])/i;

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function searchTokens(value) {
  const stopwords = new Set(["a", "o", "as", "os", "da", "de", "do", "das", "dos"]);
  const tokens = normalizeText(value).split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => !stopwords.has(token));
  return meaningful.length ? meaningful : tokens;
}

export function residentialEntityAllowed(entity) {
  const entityId = String(entity?.entity_id ?? "");
  const domain = entityId.split(".", 1)[0];
  const friendlyName = String(entity?.attributes?.friendly_name ?? "");
  return ALLOWED_DOMAINS.has(domain)
    && !INFRASTRUCTURE_PATTERN.test(`${entityId} ${friendlyName}`);
}

export function parseRequest(argv) {
  const [action, ...args] = argv;
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error("Use get, turn-on, turn-off ou toggle");
  }

  let entityId = null;
  let query = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--entity-id") entityId = args[++index];
    else if (args[index] === "--query") query = args[++index];
    else throw new Error(`Argumento desconhecido: ${args[index]}`);
  }

  if (!entityId && !query) {
    throw new Error("Informe --entity-id ou --query");
  }
  if (entityId && query) {
    throw new Error("Use somente --entity-id ou --query");
  }
  return { action, entity_id: entityId, query };
}

const INNER_SCRIPT = String.raw`
const fs = require("fs");
const crypto = require("crypto");

const request = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const allowedDomains = new Set(["light", "switch", "fan", "cover", "media_player", "vacuum", "input_boolean"]);
const infrastructurePattern = /(?:^|[_.\s-])(?:backup|codex|cpu|disk|docker|host|homeassistant|infrastructure|infraestrutura|internet|memory|mosquitto|node_?red|ollama|portainer|raspberry|rtx|storage|system|update|zigbee2mqtt)(?:$|[_.\s-])/i;
const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const searchTokens = (value) => {
  const stopwords = new Set(["a", "o", "as", "os", "da", "de", "do", "das", "dos"]);
  const tokens = normalize(value).split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => !stopwords.has(token));
  return meaningful.length ? meaningful : tokens;
};
const allowed = (entity) => {
  const entityId = String(entity?.entity_id ?? "");
  const domain = entityId.split(".", 1)[0];
  const name = String(entity?.attributes?.friendly_name ?? "");
  return allowedDomains.has(domain) && !infrastructurePattern.test(entityId + " " + name);
};

function credentials() {
  const encrypted = JSON.parse(fs.readFileSync("/data/flows_cred.json", "utf8")).$;
  const iv = Buffer.from(encrypted.slice(0, 32), "hex");
  const key = crypto.createHash("sha256").update(process.env.NODE_RED_CREDENTIAL_SECRET).digest();
  const decipher = crypto.createDecipheriv("aes-256-ctr", key, iv);
  const values = JSON.parse(decipher.update(encrypted.slice(32), "base64", "utf8") + decipher.final("utf8"));
  const flows = JSON.parse(fs.readFileSync("/data/flows.json", "utf8"));
  const server = flows.find((node) => node.type === "server" && values[node.id]?.access_token);
  if (!server) throw new Error("Credencial do Home Assistant indisponível");
  return values[server.id];
}

async function main() {
  const auth = credentials();
  const base = String(auth.host).replace(/\/$/, "");
  const headers = { Authorization: "Bearer " + auth.access_token, "Content-Type": "application/json" };
  const statesResponse = await fetch(base + "/api/states", { headers });
  if (!statesResponse.ok) throw new Error("Falha ao consultar o Home Assistant");
  const states = (await statesResponse.json()).filter(allowed);

  let matches;
  if (request.entity_id) {
    matches = states.filter((entity) => entity.entity_id === request.entity_id);
  } else {
    const needle = normalize(request.query);
    const tokens = searchTokens(request.query);
    matches = states.filter((entity) => {
      const haystack = normalize(entity.entity_id + " " + (entity.attributes?.friendly_name ?? ""));
      return haystack.includes(needle) || tokens.every((token) => haystack.includes(token));
    });
  }

  if (matches.length === 0) throw new Error("Entidade residencial não encontrada ou não autorizada");
  if (matches.length > 1) {
    console.log(JSON.stringify({ ok: false, error: "consulta_ambigua", matches: matches.slice(0, 10).map((entity) => ({ entity_id: entity.entity_id, name: entity.attributes?.friendly_name, state: entity.state })) }));
    process.exitCode = 2;
    return;
  }

  const entity = matches[0];
  if (request.action === "get") {
    console.log(JSON.stringify({ ok: true, entity_id: entity.entity_id, name: entity.attributes?.friendly_name, state: entity.state }));
    return;
  }

  const service = request.action.replace("-", "_");
  const response = await fetch(base + "/api/services/homeassistant/" + service, {
    method: "POST",
    headers,
    body: JSON.stringify({ entity_id: entity.entity_id }),
  });
  if (!response.ok) throw new Error("O Home Assistant recusou o comando residencial");
  const expectedState = request.action === "turn-off"
    ? "off"
    : request.action === "turn-on"
      ? "on"
      : entity.state === "on" ? "off" : "on";
  let finalState = "unknown";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const finalResponse = await fetch(base + "/api/states/" + entity.entity_id, { headers });
    if (finalResponse.ok) finalState = (await finalResponse.json()).state;
    if (finalState === expectedState) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(JSON.stringify({ ok: true, confirmed: finalState === expectedState, action: request.action, entity_id: entity.entity_id, name: entity.attributes?.friendly_name, state: finalState }));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
`;

export function run(request) {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  const result = spawnSync(
    "docker",
    ["exec", "-i", "nodered", "node", "-e", INNER_SCRIPT, encoded],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout || JSON.stringify({ ok: false, error: "sem_resposta" }));
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(parseRequest(process.argv.slice(2)));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
