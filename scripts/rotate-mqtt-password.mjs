import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const secretsDir = path.join(repoRoot, ".local-secrets");
const mqttPasswordPath = path.join(secretsDir, "mqtt-gabriel-password.txt");
const mosquittoPasswordPath = path.join(repoRoot, "mosquitto", "config", "password.txt");
const zigbeeConfigPath = path.join(repoRoot, "zigbee2mqtt", "configuration.yaml");
const haConfigEntriesPath = path.join(repoRoot, "homeassistant", ".storage", "core.config_entries");
const flowsPath = path.join(repoRoot, "nodered", "flows.json");
const flowsCredPath = path.join(repoRoot, "nodered", "flows_cred.json");
const runtimeConfigPath = path.join(repoRoot, "nodered", ".config.runtime.json");
const envPath = path.join(repoRoot, ".env");

const mqttUser = "gabriel";
const mqttBrokerNodeId = "721c47f31046b8bc";

function parseEnv(content) {
    const entries = new Map();
    for (const line of content.split(/\r?\n/)) {
        if (!line || line.trimStart().startsWith("#") || !line.includes("=")) {
            continue;
        }
        const index = line.indexOf("=");
        entries.set(line.slice(0, index), line.slice(index + 1).replaceAll("$$", "$"));
    }
    return entries;
}

function readCredentialSecret() {
    if (fs.existsSync(envPath)) {
        const secret = parseEnv(fs.readFileSync(envPath, "utf8")).get("NODE_RED_CREDENTIAL_SECRET");
        if (secret) {
            return secret;
        }
    }

    const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
    if (!runtimeConfig._credentialSecret) {
        throw new Error("Node-RED credential secret not found.");
    }
    return runtimeConfig._credentialSecret;
}

function decryptNodeRedCredentials(secret, encryptedCredentials) {
    const encrypted = encryptedCredentials.$;
    if (!encrypted) {
        return encryptedCredentials;
    }

    const initVector = Buffer.from(encrypted.substring(0, 32), "hex");
    const payload = encrypted.substring(32);
    const key = crypto.createHash("sha256").update(secret).digest();
    const decipher = crypto.createDecipheriv("aes-256-ctr", key, initVector);
    return JSON.parse(decipher.update(payload, "base64", "utf8") + decipher.final("utf8"));
}

function encryptNodeRedCredentials(secret, credentials) {
    const initVector = crypto.randomBytes(16);
    const key = crypto.createHash("sha256").update(secret).digest();
    const cipher = crypto.createCipheriv("aes-256-ctr", key, initVector);
    return {
        $: initVector.toString("hex") + cipher.update(JSON.stringify(credentials), "utf8", "base64") + cipher.final("base64"),
    };
}

function updateMosquittoPassword(password) {
    execFileSync(
        "docker",
        [
            "run",
            "--rm",
            "--user",
            "root",
            "-e",
            "MQTT_PASSWORD",
            "-v",
            `${path.join(repoRoot, "mosquitto", "config")}:/mosquitto/config`,
            "eclipse-mosquitto@sha256:9cfdd46ad59f3e3e5f592f6baf57ab23e1ad00605509d0f5c1e9b179c5314d87",
            "sh",
            "-c",
            "rm -f /mosquitto/config/password.txt.tmp && mosquitto_passwd -b -c /mosquitto/config/password.txt.tmp \"$1\" \"$MQTT_PASSWORD\" && mv /mosquitto/config/password.txt.tmp /mosquitto/config/password.txt && chown mosquitto:mosquitto /mosquitto/config/password.txt && chmod 600 /mosquitto/config/password.txt",
            "sh",
            mqttUser,
        ],
        { cwd: repoRoot, env: { ...process.env, MQTT_PASSWORD: password }, stdio: "inherit" },
    );
}

function updateZigbee2Mqtt(password) {
    const config = fs.readFileSync(zigbeeConfigPath, "utf8");
    const updated = config.replace(/^(\s*password:\s*).+$/m, `$1${password}`);
    if (updated === config) {
        throw new Error("Could not update Zigbee2MQTT MQTT password.");
    }
    fs.writeFileSync(zigbeeConfigPath, updated);
}

function updateHomeAssistant(password) {
    const configEntries = JSON.parse(fs.readFileSync(haConfigEntriesPath, "utf8"));
    const entries = configEntries.data?.entries || [];
    const mqttEntry = entries.find((entry) => entry.domain === "mqtt");
    if (!mqttEntry) {
        throw new Error("Home Assistant MQTT config entry not found.");
    }
    mqttEntry.data.username = mqttUser;
    mqttEntry.data.password = password;
    fs.writeFileSync(haConfigEntriesPath, `${JSON.stringify(configEntries, null, 2)}\n`);
}

function updateNodeRed(password) {
    const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
    const broker = flows.find((node) => node.id === mqttBrokerNodeId);
    if (!broker) {
        throw new Error(`Node-RED MQTT broker node not found: ${mqttBrokerNodeId}`);
    }
    broker.credentials = {};

    const secret = readCredentialSecret();
    const encryptedCredentials = JSON.parse(fs.readFileSync(flowsCredPath, "utf8"));
    const credentials = decryptNodeRedCredentials(secret, encryptedCredentials);
    credentials[mqttBrokerNodeId] = {
        user: mqttUser,
        password,
    };

    fs.writeFileSync(flowsPath, `${JSON.stringify(flows, null, 4)}\n`);
    fs.writeFileSync(flowsCredPath, `${JSON.stringify(encryptNodeRedCredentials(secret, credentials), null, 4)}\n`);
}

function updateContainerOwnedFiles(password) {
    execFileSync(
        "docker",
        [
            "run",
            "--rm",
            "--user",
            "root",
            "-e",
            "MQTT_PASSWORD",
            "-e",
            "ROTATE_MQTT_IN_CONTAINER=1",
            "-v",
            `${repoRoot}:/repo`,
            "-w",
            "/repo",
            "--entrypoint",
            "node",
            "nodered/node-red@sha256:330d65c5d9c203df1fc4db8dc7a67cf15c3b3982c85d0f7e0f1aa90dbb8b43f9",
            "scripts/rotate-mqtt-password.mjs",
        ],
        { cwd: repoRoot, env: { ...process.env, MQTT_PASSWORD: password }, stdio: "inherit" },
    );
}

if (process.env.ROTATE_MQTT_IN_CONTAINER === "1") {
    const password = process.env.MQTT_PASSWORD;
    if (!password) {
        throw new Error("MQTT_PASSWORD is required in container update mode.");
    }
    updateZigbee2Mqtt(password);
    updateHomeAssistant(password);
    updateNodeRed(password);
    process.exit(0);
}

const password = crypto.randomBytes(30).toString("base64url");
fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(mqttPasswordPath, `${password}\n`, { mode: 0o600 });
fs.chmodSync(secretsDir, 0o700);
fs.chmodSync(mqttPasswordPath, 0o600);

updateMosquittoPassword(password);
updateContainerOwnedFiles(password);

console.log(`MQTT user updated: ${mqttUser}`);
console.log(`MQTT password saved at: ${mqttPasswordPath}`);
