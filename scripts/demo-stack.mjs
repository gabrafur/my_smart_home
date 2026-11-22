#!/usr/bin/env node
// Synthetic demo stack: Home Assistant (built-in demo integration), Mosquitto
// and Node-RED in their own Compose project, published on 127.0.0.1 only.
// It never reads private bindings, secrets or the household stack.
//
//   node scripts/demo-stack.mjs up           start containers and finish setup
//   node scripts/demo-stack.mjs setup        onboarding + MQTT entry on a running HA
//   node scripts/demo-stack.mjs screenshots  write docs/assets/generated/demo-*.png
//   node scripts/demo-stack.mjs down         stop and remove the demo containers and volumes

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const project = "smart-home-demo";
export const composeFile = path.join(repoRoot, "demo", "stack", "compose.yml");
const runtimeDir = path.join(repoRoot, "demo", "stack", ".runtime");
export const defaults = {
  haUrl: process.env.DEMO_HA_URL || "http://127.0.0.1:8124",
  nodeRedUrl: process.env.DEMO_NODE_RED_URL || "http://127.0.0.1:1881",
  mqttHost: process.env.DEMO_MQTT_HOST || "mosquitto",
  mqttPort: Number(process.env.DEMO_MQTT_PORT || 1883),
};
export const screenshots = [
  { file: "demo-casa.png", path: "/painel-casa-demo/inicio" },
  { file: "demo-sistema.png", path: "/painel-sistema-demo/saude" },
];

function log(message) {
  process.stdout.write(`[demo-stack] ${message}\n`);
}

function compose(args) {
  const result = spawnSync("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") throw new Error("docker is not installed; the demo stack needs Docker Engine with the Compose plugin");
  if (result.status !== 0) throw new Error(`docker compose ${args.join(" ")} failed`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, { method = "GET", token, json, form } = {}) {
  const headers = {};
  let body;
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const response = await fetch(url, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, data };
}

export async function waitFor(url, { timeoutMs = 300_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// Onboarding creates one local demo user with a random password, kept only in
// the ignored demo/stack/.runtime directory and printed by `up`; a later
// `setup` reads it to resume an interrupted configuration.
const userFile = path.join(runtimeDir, "demo-user.txt");

async function exchangeCode(haUrl, code) {
  const token = await request(`${haUrl}/auth/token`, {
    method: "POST",
    form: { grant_type: "authorization_code", code, client_id: `${haUrl}/` },
  });
  if (!token.data?.access_token) throw new Error(`token exchange failed (${token.status})`);
  return token.data.access_token;
}

export function demoCredentials() {
  if (!fs.existsSync(userFile)) {
    throw new Error("the demo user file is missing; run `make demo-stack-down` and `make demo-stack` again");
  }
  const text = fs.readFileSync(userFile, "utf8");
  return { username: text.match(/^username=(.+)$/m)?.[1] ?? "demo", password: text.match(/^password=(.+)$/m)?.[1] };
}

async function login(haUrl) {
  const { password } = demoCredentials();
  const clientId = `${haUrl}/`;
  const flow = await request(`${haUrl}/auth/login_flow`, {
    method: "POST", json: { client_id: clientId, handler: ["homeassistant", null], redirect_uri: clientId },
  });
  const result = await request(`${haUrl}/auth/login_flow/${flow.data?.flow_id}`, {
    method: "POST", json: { username: "demo", password, client_id: clientId },
  });
  if (result.data?.type !== "create_entry") throw new Error("could not log in as the demo user");
  return exchangeCode(haUrl, result.data.result);
}

async function onboard(haUrl) {
  const clientId = `${haUrl}/`;
  const password = crypto.randomBytes(18).toString("base64url");
  const user = await request(`${haUrl}/api/onboarding/users`, {
    method: "POST",
    json: { client_id: clientId, name: "Demo", username: "demo", password, language: "pt-BR" },
  });
  if (user.status !== 200 || !user.data?.auth_code) throw new Error(`onboarding user step failed (${user.status})`);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(userFile, `username=demo\npassword=${password}\n`, { mode: 0o600 });
  const accessToken = await exchangeCode(haUrl, user.data.auth_code);
  for (const [step, json] of [
    ["core_config", {}],
    ["analytics", {}],
    ["integration", { client_id: clientId, redirect_uri: `${haUrl}/?auth_callback=1` }],
  ]) {
    const result = await request(`${haUrl}/api/onboarding/${step}`, { method: "POST", token: accessToken, json });
    if (result.status !== 200) throw new Error(`onboarding ${step} step failed (${result.status})`);
  }
  return accessToken;
}

// Fill the MQTT form from its own schema: required defaults, the demo broker,
// MQTT 3.1.1 and plain TCP inside the expandable "other settings" section.
export function mqttUserInput(schema, { host, port }) {
  const input = { broker: host, port, protocol: "3.1.1" };
  for (const field of schema ?? []) {
    if (field.type !== "expandable") continue;
    const section = {};
    for (const inner of field.schema ?? []) {
      if (inner.name === "set_client_cert") section.set_client_cert = false;
      else if (inner.name === "set_ca_cert") section.set_ca_cert = "off";
      else if (inner.name === "transport") section.transport = "tcp";
      else if (inner.required && inner.default !== undefined) section[inner.name] = inner.default;
    }
    input[field.name] = section;
  }
  return input;
}

async function ensureMqtt(haUrl, token, { host, port }) {
  const entries = await request(`${haUrl}/api/config/config_entries/entry?domain=mqtt`, { token });
  if (Array.isArray(entries.data) && entries.data.length) return false;
  const flow = await request(`${haUrl}/api/config/config_entries/flow`, {
    method: "POST", token, json: { handler: "mqtt", show_advanced_options: false },
  });
  let step = flow.data;
  if (step?.type === "form") {
    step = (await request(`${haUrl}/api/config/config_entries/flow/${step.flow_id}`, {
      method: "POST", token, json: mqttUserInput(step.data_schema, { host, port }),
    })).data;
  }
  if (step?.type !== "create_entry") {
    throw new Error(`MQTT setup did not create an entry (${step?.type ?? flow.status}: ${JSON.stringify(step?.errors ?? {})})`);
  }
  return true;
}

export async function setup({ haUrl = defaults.haUrl, mqttHost = defaults.mqttHost, mqttPort = defaults.mqttPort } = {}) {
  await waitFor(`${haUrl}/api/onboarding`);
  const steps = (await request(`${haUrl}/api/onboarding`)).data;
  const userDone = (Array.isArray(steps) ? steps : []).some((step) => step.step === "user" && step.done);
  const token = userDone ? await login(haUrl) : await onboard(haUrl);
  const created = await ensureMqtt(haUrl, token, { host: mqttHost, port: mqttPort });
  // Publish the current facts now so Node-RED decides right away.
  await request(`${haUrl}/api/services/automation/trigger`, {
    method: "POST", token, json: { entity_id: "automation.demo_publicar_fatos_atuais" },
  });
  log(`MQTT ${created ? "connected" : "already configured"}; Home Assistant ready at ${haUrl}`);
  return { onboarded: !userDone, mqttCreated: created };
}

export async function takeScreenshots({ haUrl = defaults.haUrl, outDir = path.join(repoRoot, "docs", "assets", "generated") } = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    try {
      // CommonJS resolution also honours NODE_PATH (globally installed Playwright).
      ({ chromium } = createRequire(import.meta.url)("playwright"));
    } catch {
      throw new Error("screenshots need Playwright: npm install --no-save playwright && npx playwright install chromium");
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: "pt-BR", colorScheme: "dark", deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`${haUrl}/`, { waitUntil: "networkidle" });
    if (new URL(page.url()).pathname.startsWith("/auth/")) {
      const { username, password } = demoCredentials();
      await page.locator('input[name="username"]').fill(username);
      await page.locator('input[name="password"]').fill(password);
      await page.locator('input[name="password"]').press("Enter");
    }
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"), { timeout: 60_000 });
    for (const shot of screenshots) {
      await page.goto(`${haUrl}${shot.path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(4_000);
      const target = path.join(outDir, shot.file);
      await page.screenshot({ path: target });
      const strip = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "strip-png-metadata.mjs"), target], { stdio: "inherit" });
      if (strip.status !== 0) throw new Error(`could not strip metadata from ${shot.file}`);
      log(`wrote ${path.relative(repoRoot, target)}`);
    }
  } finally {
    await browser.close();
  }
}

async function main(command) {
  if (command === "up") {
    compose(["up", "-d", "--wait"]);
    await setup();
    const { username, password } = demoCredentials();
    log(`Home Assistant: ${defaults.haUrl}  user: ${username}  password: ${password} (synthetic, local only)`);
    log(`Node-RED: ${defaults.nodeRedUrl}  (credentials also in demo/stack/.runtime/demo-user.txt)`);
  } else if (command === "setup") {
    await setup();
  } else if (command === "screenshots") {
    await takeScreenshots();
  } else if (command === "down") {
    compose(["down", "--volumes", "--remove-orphans"]);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  } else {
    throw new Error("usage: node scripts/demo-stack.mjs up|setup|screenshots|down");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(`[demo-stack] ${error.message}`);
    process.exit(1);
  });
}
