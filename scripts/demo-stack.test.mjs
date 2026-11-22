import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { mqttUserInput, screenshots } from "./demo-stack.mjs";

const require = createRequire(import.meta.url);
const { parse } = require("../validation/node_modules/yaml");
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const compose = parse(read("demo/stack/compose.yml"));
const services = compose.services;

test("demo services publish only on 127.0.0.1 and take no host privileges", () => {
  assert.deepEqual(Object.keys(services).sort(), ["homeassistant", "mosquitto", "nodered"]);
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) assert.match(port, /^127\.0\.0\.1:\d+:\d+$/, `${name} port ${port}`);
    for (const key of ["privileged", "network_mode", "devices", "cap_add", "pid", "ipc", "group_add"]) {
      assert.equal(service[key], undefined, `${name} must not set ${key}`);
    }
  }
  assert.equal(services.mosquitto.ports, undefined, "the anonymous demo broker is never published");
});

test("demo mounts no private state, secrets or household configuration", () => {
  const forbidden = [/bindings\/private/, /\.storage/, /secrets/, /\.env/, /\.local-secrets/, /docker\.sock/, /^\/(?!config|data|demo|mosquitto)/,
    /^\.\.\/\.\.\/homeassistant\/(?!themes$)/];
  for (const [name, service] of Object.entries(services)) {
    for (const volume of service.volumes ?? []) {
      const source = volume.split(":")[0];
      for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name} mounts ${source}`);
    }
  }
});

test("demo images are the digests pinned for the real stack", () => {
  const real = parse(read("docker-compose.yml")).services;
  for (const name of Object.keys(services)) {
    assert.match(services[name].image, /@sha256:[0-9a-f]{64}$/);
    assert.equal(services[name].image, real[name].image, `${name} digest drifted from docker-compose.yml`);
  }
});

test("the demo Node-RED flow uses only core nodes and never targets a device", () => {
  const flows = JSON.parse(read("demo/stack/nodered/flows.json"));
  const core = new Set(["tab", "group", "mqtt-broker", "mqtt in", "mqtt out", "inject", "change", "function", "catch"]);
  for (const node of flows) assert.ok(core.has(node.type), `unexpected node type ${node.type}`);
  const outputs = flows.filter((node) => node.type === "mqtt out").map((node) => node.topic);
  for (const topic of outputs) assert.match(topic, /^smart-home-demo\//);
  const decide = flows.find((node) => node.id === "demo_decide");
  assert.match(decide.func, /simulated: true/);
  assert.match(decide.func, /dispatched: false/);
  assert.equal(flows.find((node) => node.type === "mqtt-broker").broker, "${MQTT_HOST}");
});

test("demo Home Assistant uses only demo entities and keeps password login", () => {
  const config = read("demo/stack/homeassistant/configuration.yaml");
  assert.match(config, /^demo:/m);
  assert.doesNotMatch(config, /trusted_networks|allow_bypass_login/);
  for (const dashboard of ["casa", "sistema"]) {
    const yaml = read(`demo/stack/homeassistant/dashboards/${dashboard}.yaml`);
    for (const [, entity] of yaml.matchAll(/entity: ([a-z_]+\.[a-z0-9_]+)/g)) {
      assert.doesNotMatch(entity, /resident|vehicle|moni|portao|rele|creta/, `${dashboard} uses a household entity ${entity}`);
    }
  }
});

test("MQTT form input is derived from the integration schema", () => {
  const schema = [
    { name: "broker", required: true },
    { name: "port", required: true, default: 1883 },
    { type: "expandable", name: "other_settings", schema: [
      { name: "set_client_cert", required: true },
      { name: "set_ca_cert", required: true },
      { name: "transport", required: true, default: "tcp" },
      { name: "keepalive", required: false },
    ] },
  ];
  assert.deepEqual(mqttUserInput(schema, { host: "mosquitto", port: 1883 }), {
    broker: "mosquitto", port: 1883, protocol: "3.1.1",
    other_settings: { set_client_cert: false, set_ca_cert: "off", transport: "tcp" },
  });
});

test("screenshots land in the generated assets folder the weekly review may update", () => {
  for (const shot of screenshots) assert.match(shot.file, /^demo-[a-z]+\.png$/);
});
