import { execFileSync } from "node:child_process";

// Runs inside the existing Node-RED container. Credentials never leave it.
export const mqttProbeScript = String.raw`
const fs = require("fs"), crypto = require("crypto"), mqtt = require("mqtt");
const timer = setTimeout(() => process.exit(1), 7000);
try {
  const encrypted = JSON.parse(fs.readFileSync("/data/flows_cred.json", "utf8")).$;
  const key = crypto.createHash("sha256").update(process.env.NODE_RED_CREDENTIAL_SECRET).digest();
  const decipher = crypto.createDecipheriv("aes-256-ctr", key, Buffer.from(encrypted.slice(0, 32), "hex"));
  const values = JSON.parse(decipher.update(encrypted.slice(32), "base64", "utf8") + decipher.final("utf8"));
  const flows = JSON.parse(fs.readFileSync("/data/flows.json", "utf8"));
  const broker = flows.find(n => n.type === "mqtt-broker" && n.broker === "mosquitto" && !n.usetls && values[n.id]);
  const auth = values[broker.id];
  const client = mqtt.connect({host: "mosquitto", port: Number(broker.port || 1883),
    username: auth.user, password: auth.password, reconnectPeriod: 0, connectTimeout: 5000});
  client.on("error", () => process.exit(1));
  client.once("connect", () => client.end(false, {}, () => {clearTimeout(timer); process.exit(0);}));
} catch { process.exit(1); }
`;

export const zigbeeProbeScript = String.raw`
const fs = require("fs"), mqtt = require("mqtt"), yaml = require("js-yaml");
const timer = setTimeout(() => process.exit(1), 7000);
try {
  const config = yaml.load(fs.readFileSync("/app/data/configuration.yaml", "utf8"));
  const env = process.env;
  const topic = (env.ZIGBEE2MQTT_CONFIG_MQTT_BASE_TOPIC || config.mqtt.base_topic || "zigbee2mqtt") + "/bridge/state";
  const client = mqtt.connect(env.ZIGBEE2MQTT_CONFIG_MQTT_SERVER || config.mqtt.server, {
    username: env.ZIGBEE2MQTT_CONFIG_MQTT_USER || config.mqtt.user,
    password: env.ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD || config.mqtt.password,
    reconnectPeriod: 0, connectTimeout: 5000});
  client.on("error", () => process.exit(1));
  client.once("connect", () => client.subscribe(topic, {qos: 0}, (err, grants) => {
    if (err || !grants.length || grants.some(g => g.qos === 128)) process.exit(1);
  }));
  client.on("message", (received, payload) => {
    if (received !== topic) return;
    let state = payload.toString();
    try { state = JSON.parse(state).state; } catch {}
    if (state === "online") client.end(false, {}, () => {clearTimeout(timer); process.exit(0);});
  });
} catch { process.exit(1); }
`;

export const nodeRedProbeScript = String.raw`
const http = require("http");
const request = http.get("http://127.0.0.1:1880/auth/login", response => {
  response.resume();
  response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
});
request.setTimeout(5000, () => request.destroy());
request.on("error", () => process.exit(1));
`;

export function startupComplete(service, logs) {
  const markers = service === "nodered"
    ? [/Started flows/g, /Stopping flows|Stopped flows/g]
    : [/Zigbee2MQTT started!/g, /Stopping Zigbee2MQTT|Stopped Zigbee2MQTT/g];
  const last = regex => [...logs.matchAll(regex)].at(-1)?.index ?? -1;
  return last(markers[0]) > last(markers[1]);
}

export function probeService(service, { execute = execFileSync } = {}) {
  const docker = args => execute("docker", args, {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!["mosquitto", "nodered", "zigbee2mqtt"].includes(service)) return null;
  try {
    if (service !== "mosquitto") {
      const started = docker(["inspect", service, "--format", "{{.State.StartedAt}}"] ).trim();
      if (!/^\d{4}-\d{2}-\d{2}T/.test(started)) return false;
      // Node-RED logs to stdout; Zigbee2MQTT does too. Never print log contents.
      const logs = docker(["logs", "--since", started, "--tail", "500", service]);
      if (!startupComplete(service, logs)) return false;
    }
    docker(["exec", service === "mosquitto" ? "nodered" : service, "node", "-e",
      service === "mosquitto" ? mqttProbeScript : service === "nodered" ? nodeRedProbeScript : zigbeeProbeScript]);
    return true;
  } catch { return false; }
}

export function requireReadinessCoverage(services, inspectHealth) {
  for (const service of services) {
    if (["mosquitto", "nodered", "zigbee2mqtt"].includes(service)) continue;
    if (!inspectHealth(service)) throw new Error(`Service ${service} has no readiness probe or healthcheck; update blocked before recreation`);
  }
}
