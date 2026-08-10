import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const envPath = path.join(repoRoot, ".env");
const secretsDir = path.join(repoRoot, ".local-secrets");
const passwordPath = path.join(secretsDir, "node-red-admin-password.txt");
const runtimePath = path.join(repoRoot, "nodered", ".config.runtime.json");

function parseEnv(content) {
    const entries = new Map();
    for (const line of content.split(/\r?\n/)) {
        if (!line || line.trimStart().startsWith("#") || !line.includes("=")) {
            continue;
        }
        const index = line.indexOf("=");
        entries.set(line.slice(0, index), line.slice(index + 1));
    }
    return entries;
}

function stringifyEnv(entries) {
    return `${Array.from(entries.entries())
        .map(([key, value]) => `${key}=${String(value).replaceAll("$", () => "$$")}`)
        .join("\n")}\n`;
}

function readExistingPassword() {
    try {
        return fs.readFileSync(passwordPath, "utf8").trim();
    } catch (err) {
        return crypto.randomBytes(24).toString("base64url");
    }
}

function readCredentialSecret() {
    if (fs.existsSync(runtimePath)) {
        const runtimeConfig = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
        if (runtimeConfig._credentialSecret) {
            return runtimeConfig._credentialSecret;
        }
    }
    return crypto.randomBytes(32).toString("hex");
}

function bcryptHash(password) {
    return execFileSync(
        "docker",
        [
            "run",
            "--rm",
            "--entrypoint",
            "node",
            "nodered/node-red@sha256:10f40d0a83e7e5852b13d4d472b2006b05b1cca6d55e2f29a55a12c25a630cb6",
            "-e",
            "const bcrypt=require('bcryptjs'); console.log(bcrypt.hashSync(process.argv[1], 8));",
            password,
        ],
        { cwd: repoRoot, encoding: "utf8" },
    ).trim();
}

const password = readExistingPassword();
const entries = fs.existsSync(envPath)
    ? parseEnv(fs.readFileSync(envPath, "utf8"))
    : new Map();

const isPlaceholder = (value) => !value || /^(replace-with|CHANGE_ME|optional-)/i.test(value);

entries.set("HOST_LAN_IP", entries.get("HOST_LAN_IP") || "127.0.0.1");
entries.set("NODE_RED_ADMIN_USER", entries.get("NODE_RED_ADMIN_USER") || "admin");
const socketGid = fs.existsSync("/var/run/docker.sock")
    ? String(fs.statSync("/var/run/docker.sock").gid)
    : "999";
if (!entries.get("DOCKER_GID") || entries.get("DOCKER_GID") === "999") {
    entries.set("DOCKER_GID", socketGid);
}
entries.set(
    "NODE_RED_CREDENTIAL_SECRET",
    isPlaceholder(entries.get("NODE_RED_CREDENTIAL_SECRET"))
        ? readCredentialSecret()
        : entries.get("NODE_RED_CREDENTIAL_SECRET"),
);
entries.set("NODE_RED_ADMIN_PASSWORD_HASH", bcryptHash(password));

fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(envPath, stringifyEnv(entries), { mode: 0o600 });
fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
fs.chmodSync(passwordPath, 0o600);

console.log(`Node-RED admin user: ${entries.get("NODE_RED_ADMIN_USER")}`);
console.log(`Node-RED admin password saved at: ${passwordPath}`);
console.log(`Environment saved at: ${envPath}`);
