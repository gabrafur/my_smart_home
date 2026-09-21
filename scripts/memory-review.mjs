#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest } from "./memory-evidence.mjs";
import { checkPublicMemory } from "./public-memory-check.mjs";

const outcomes = new Set(["updated", "already_current", "no_durable_discovery", "unverified"]);
const message = "MEMORY_REVIEW_FAILED: revisão de memória pendente; não declare esta tarefa integralmente concluída. Consulte docs/MEMORIA_VERSIONADA_AGENTES.md.";

function stateDirectory(root) {
  const directory = path.join(root, ".local-state/memory-review");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error("checkpoint symlink rejected");
  return directory;
}

function readState(root, sessionKey) {
  const file = path.join(stateDirectory(root), `${sessionKey}.json`);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("checkpoint symlink rejected");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeState(root, sessionKey, state) {
  const file = path.join(stateDirectory(root), `${sessionKey}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  let owned = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    owned = true;
    try { fs.writeFileSync(fd, `${JSON.stringify(state)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally {
    if (owned && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function publicSnapshot(root, trackedFiles) {
  // Git never consumes stdin here. An unnecessary stdin pipe can be denied
  // by the client's sandbox even when read-only Git commands are permitted.
  const files = trackedFiles ?? execFileSync("git", ["ls-files", "-z"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(Boolean);
  const memories = files.filter((f) => /^\.codex\/memories\/.+\.md$/.test(f)).sort();
  if (!memories.length) throw new Error("public memory unavailable");
  const fingerprint = digest(memories.map((f) => {
    const target = path.join(root, f);
    if (fs.realpathSync(target) !== path.resolve(target)) throw new Error("memory symlink rejected");
    return `${f}\0${digest(fs.readFileSync(target))}`;
  }).join("\n"));
  return { files, fingerprint };
}

function checkedSnapshot(root, trackedFiles) {
  const snapshot = publicSnapshot(root, trackedFiles);
  const result = checkPublicMemory({ repoRoot: root, trackedFiles: snapshot.files });
  if (result.errors.length) throw new Error("public memory validation failed; run node scripts/public-memory-check.mjs");
  return snapshot;
}

export function completeReview(root, token, outcome, { trackedFiles } = {}) {
  if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(token) || !outcomes.has(outcome)) throw new Error("invalid checkpoint token/outcome");
  const [sessionKey, reviewId] = token.split(":");
  const state = readState(root, sessionKey);
  if (!state || state.review_id !== reviewId || state.status !== "pending") throw new Error("checkpoint is missing, stale or already closed");
  const snapshot = checkedSnapshot(root, trackedFiles);
  if (outcome === "updated" && snapshot.fingerprint === state.initial_memory_sha256) throw new Error("updated requires a persisted memory change");
  writeState(root, sessionKey, {
    ...state, status: "reviewed", outcome, memory_sha256: snapshot.fingerprint,
  });
  return { status: "reviewed", outcome };
}

// Only identifiers are consumed. Prompt, transcript_path and assistant text
// are deliberately ignored and never stored, parsed for facts or sent out.
export function stopReview(root, payload, { trackedFiles } = {}) {
  if (payload.hook_event_name !== "Stop") return {};
  if (typeof payload.session_id !== "string" || !payload.session_id || typeof payload.turn_id !== "string" || !payload.turn_id) {
    return { continue: false, stopReason: message, systemMessage: message };
  }
  const sessionKey = digest(payload.session_id);
  const turnKey = digest(payload.turn_id);
  let state = readState(root, sessionKey);
  // Stop continuations may receive a new turn id. Only an explicitly marked
  // continuation can reuse the pending checkpoint from the same session.
  if (!state || (state.turn_sha256 !== turnKey && payload.stop_hook_active !== true)) {
    state = {
      schema: 1, review_id: digest(`${sessionKey}:${turnKey}`), turn_sha256: turnKey,
      status: "pending", attempts: 0, initial_memory_sha256: publicSnapshot(root, trackedFiles).fingerprint,
    };
  }
  if (state.status === "reviewed") {
    const snapshot = checkedSnapshot(root, trackedFiles);
    if (state.memory_sha256 === snapshot.fingerprint) {
      if (state.outcome === "unverified") return { continue: false, stopReason: message, systemMessage: message };
      return {};
    }
    state = { ...state, status: "pending", outcome: undefined, memory_sha256: undefined };
  }
  if (state.attempts >= 2) {
    writeState(root, sessionKey, { ...state, status: "failed" });
    return { continue: false, stopReason: message, systemMessage: message };
  }
  state = { ...state, attempts: state.attempts + 1 };
  writeState(root, sessionKey, state);
  const token = `${sessionKey}:${state.review_id}`;
  return {
    decision: "block",
    reason: `Antes de encerrar, revise as descobertas desta tarefa para a memória pública. Use apenas o contexto já disponível e fontes públicas atuais; não leia transcripts, não acione dispositivos e não importe dados privados. Consulte o índice e docs/MEMORIA_VERSIONADA_AGENTES.md. Persista decisões úteis verificadas no tema existente, preferindo scripts/memory-candidate.mjs. Não invente uma memória para satisfazer este gate. Se já registrada, use already_current; sem descoberta durável, no_durable_discovery; se não puder verificar, unverified e informe a pendência. Depois execute: node scripts/memory-review.mjs complete ${token} <updated|already_current|no_durable_discovery|unverified>. Este checkpoint valida a memória, não requer commit/push ou validação ampla adicional. Preserve o trabalho concorrente.`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "..");
  try {
    const [command, token, outcome] = process.argv.slice(2);
    let result;
    if (command === "complete") result = completeReview(root, token, outcome);
    else if (command === "hook") {
      let payload;
      try { payload = JSON.parse(fs.readFileSync(0, "utf8")); }
      catch { throw new Error("invalid hook input"); }
      result = stopReview(root, payload);
    } else throw new Error("usage: memory-review.mjs hook | complete <token> <outcome>");
    console.log(JSON.stringify(result));
  } catch (error) {
    // A failing hook must surface the gap without leaking input or retrying
    // indefinitely on the residential host.
    const reasonCode = /^[A-Z][A-Z_0-9]{1,60}$/.test(error?.code ?? "")
      ? error.code
      : /public memory validation failed/.test(error?.message ?? "")
        ? "PUBLIC_MEMORY_INVALID"
        : /checkpoint is missing, stale or already closed/.test(error?.message ?? "")
          ? "CHECKPOINT_STALE"
          : "CHECKPOINT_ERROR";
    const diagnostic = `${message} Código: ${reasonCode}.`;
    console.log(JSON.stringify({ continue: false, stopReason: diagnostic, systemMessage: diagnostic }));
    if (process.argv[2] !== "hook") process.exitCode = 1;
  }
}
