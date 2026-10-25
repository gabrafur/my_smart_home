import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unknown = reason => ({ state: "unknown", reason, no_effects: true });

export async function inspectActivity(invoke) {
  try {
    const listed = await invoke("thread/loaded/list", { limit: 65 });
    if (!Array.isArray(listed?.data) || listed.data.length > 64 || listed.nextCursor != null ||
        listed.data.some(id => typeof id !== "string" || !UUID.test(id)) ||
        new Set(listed.data).size !== listed.data.length) return unknown("loaded_scope_unconfirmed");
    for (const threadId of listed.data) {
      const row = await invoke("thread/read", { threadId, includeTurns: false });
      if (row?.thread?.id !== threadId) return unknown("thread_identity_unconfirmed");
      const state = row.thread.status?.type;
      if (state === "active") return { state: "busy", reason: "active_turn", no_effects: true };
      if (state !== "idle") return unknown("thread_state_unconfirmed");
      const result = await invoke("thread/goal/get", { threadId });
      if (!result || !Object.hasOwn(result, "goal")) return unknown("goal_state_unconfirmed");
      if (result.goal !== null) {
        if (result.goal.threadId !== threadId) return unknown("goal_identity_unconfirmed");
        if (result.goal.status === "active") return { state: "busy", reason: "active_goal", no_effects: true };
        if (!["paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(result.goal.status))
          return unknown("goal_state_unconfirmed");
      }
    }
    const after = await invoke("thread/loaded/list", { limit: 65 });
    if (!Array.isArray(after?.data) || after.nextCursor != null ||
        JSON.stringify([...after.data].sort()) !== JSON.stringify([...listed.data].sort()))
      return unknown("loaded_scope_changed");
    return { state: "idle", reason: "loaded_threads_and_goals_inactive", no_effects: true };
  } catch { return unknown("activity_collection_failed"); }
}

export function readActivity(controlSocket, { run = spawnSync } = {}) {
  const script = fileURLToPath(import.meta.url);
  const result = run(process.execPath, ["--max-old-space-size=48", script], {
    encoding: "utf8", timeout: 10000, maxBuffer: 4096,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_REMOTE_CONTROL_SOCKET: controlSocket },
  });
  try {
    if (result.status !== 0 || result.error) return unknown("activity_collection_failed");
    const value = JSON.parse(result.stdout);
    if (!["idle", "busy", "unknown"].includes(value.state) || value.no_effects !== true ||
        !/^[a-z_]{1,64}$/.test(value.reason)) return unknown("activity_collection_failed");
    return { state: value.state, reason: value.reason, no_effects: true };
  } catch { return unknown("activity_collection_failed"); }
}

async function collect(controlSocket) {
  const status = spawnSync("ss", ["-xl"], { encoding: "utf8", timeout: 2000, maxBuffer: 262144 });
  if (status.status !== 0 || status.error) return unknown("listener_collection_failed");
  let physical = controlSocket;
  try { physical = fs.realpathSync(controlSocket); } catch { /* An absent alias remains an exact socket lookup. */ }
  if (!String(status.stdout).split(/\r?\n/).some(line => line.trim().split(/\s+/).includes(physical)))
    return { state: "idle", reason: "configured_listener_absent", no_effects: true };
  const require = createRequire(import.meta.url);
  const WebSocket = require("../nodered/node_modules/ws");
  return await new Promise(resolve => {
    const ws = new WebSocket(`ws+unix://${controlSocket}:/`, { handshakeTimeout: 2000,
      maxPayload: 131072, perMessageDeflate: false });
    let id = 0, settled = false;
    const pending = new Map();
    const finish = value => {
      if (settled) return; settled = true; clearTimeout(timer);
      for (const { reject } of pending.values()) reject(Error("closed"));
      pending.clear(); ws.terminate(); resolve(value);
    };
    const timer = setTimeout(() => finish(unknown("activity_collection_failed")), 8000);
    const invoke = (method, params) => new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }));
    });
    ws.on("message", data => {
      try {
        const value = JSON.parse(data); const entry = pending.get(value.id);
        if (!entry) return; pending.delete(value.id);
        if (value.error) entry.reject(Error("rpc_refused")); else entry.resolve(value.result);
      } catch { finish(unknown("activity_collection_failed")); }
    });
    ws.on("error", () => finish(unknown("activity_collection_failed")));
    ws.on("close", () => finish(unknown("activity_collection_failed")));
    ws.on("open", async () => {
      try {
        await invoke("initialize", { clientInfo: { name: "residential_update_idle_check", version: "1.0" },
          capabilities: { experimentalApi: true } });
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
        finish(await inspectActivity(invoke));
      } catch { finish(unknown("activity_collection_failed")); }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) process.exitCode = 64;
  else {
    const socket = process.env.CODEX_REMOTE_CONTROL_SOCKET || "/home/gabriel/.codex/app-server-control/app-server-control.sock";
    let result;
    try { result = await collect(socket); } catch { result = unknown("activity_collection_failed"); }
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}
