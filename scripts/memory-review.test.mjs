import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { startReview, stopReview, completeReview } from "./memory-review.mjs";
import { applyCandidate } from "./memory-candidate.mjs";
import { fixture, target, source } from "./test-support/memory-fixture.mjs";

const event = { hook_event_name: "Stop", session_id: "synthetic-session", turn_id: "synthetic-turn", stop_hook_active: false };
const start = (root, payload = event, options) => startReview(root, { ...payload, hook_event_name: "UserPromptSubmit" }, options);
const tokenOf = (result) => result.hookSpecificOutput.additionalContext.match(/[a-f0-9]{64}:[a-f0-9]{64}/)[0];

test("memory-only restrictions preserve authorized operational diagnostics", (t) => {
  const f = fixture(t);
  const context = start(f.root, event, f).hookSpecificOutput.additionalContext;
  assert.match(context, /Escopo exclusivo da revisão de memória pública:/);
  assert.match(context, /não importe dados privados para a memória pública/);
  assert.match(context, /não acione dispositivos para produzir evidência de memória/);
  assert.match(context, /Essas limitações não restringem a tarefa operacional solicitada pelo usuário/);
  assert.match(context, /consultas autorizadas a logs, histórico de notificações, bancos de dados e configuração privada/);
  assert.match(context, /siga as autorizações e demais regras aplicáveis à tarefa/);
  assert.match(context, /sem copiar conteúdo privado para arquivos públicos/);
  assert.doesNotMatch(context, /não acione dispositivos e não importe dados privados\./);
});

test("successful review requests silent completion while preserving the checkpoint", (t) => {
  for (const outcome of ["updated", "already_current", "no_durable_discovery"]) {
    const f = fixture(t);
    const result = start(f.root, event, f);
    assert.equal(result.decision, undefined);
    assert.equal(result.reason, undefined);
    assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(result.systemMessage, undefined);
    assert.equal(result.suppressOutput, undefined);
    assert.match(result.hookSpecificOutput.additionalContext, /Não envie mensagens de início, progresso ou confirmação da revisão no chat/);
    assert.match(result.hookSpecificOutput.additionalContext, /Antes da resposta final/);
    assert.match(result.hookSpecificOutput.additionalContext, /Informe apenas uma pendência real/);
    if (outcome === "updated") applyCandidate(f.root, f.candidate(), { ...f, apply: true });
    assert.deepEqual(completeReview(f.root, tokenOf(result), outcome, f), { status: "reviewed", outcome });
    assert.deepEqual(stopReview(f.root, event, f), {});
  }
});

test("review and candidate discover tracked files through Git without an injected manifest", (t) => {
  const f = fixture(t);
  const git = (args, input) => execFileSync("git", args, {
    cwd: f.root, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  git(["init", "--quiet"]);
  const emptyBlob = git(["hash-object", "-w", "--stdin"], "").trim();
  git(["update-index", "--index-info"], f.trackedFiles.map((file) => `100644 ${emptyBlob}\t${file}\n`).join(""));
  const result = start(f.root, event);
  applyCandidate(f.root, f.candidate(), { apply: true });
  assert.equal(completeReview(f.root, tokenOf(result), "updated").status, "reviewed");
  assert.deepEqual(stopReview(f.root, event), {});
});

test("review starts before completion; persisted useful memory permits completion", (t) => {
  const f = fixture(t);
  const result = start(f.root, event, f);
  assert.equal(result.decision, undefined);
  assert.equal(result.reason, undefined);
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.throws(() => completeReview(f.root, tokenOf(result), "updated", f), /persisted memory change/);
  applyCandidate(f.root, f.candidate(), { ...f, apply: true });
  assert.equal(completeReview(f.root, tokenOf(result), "updated", f).status, "reviewed");
  assert.deepEqual(stopReview(f.root, event, f), {});
  assert.equal(stopReview(f.root, { ...event, turn_id: "continuation", stop_hook_active: true }, f).continue, false);
});

test("ordinary conversations can record no durable discovery without creating a note", (t) => {
  const f = fixture(t);
  const before = f.read();
  const result = start(f.root, event, f);
  completeReview(f.root, tokenOf(result), "no_durable_discovery", f);
  assert.equal(f.read(), before);
  assert.deepEqual(stopReview(f.root, event, f), {});
  assert.equal(stopReview(f.root, { ...event, turn_id: "new-user-turn" }, f).continue, false);
});

test("checkpoint does not ingest prompts, assistant messages, transcripts or identities", (t) => {
  const f = fixture(t);
  start(f.root, { ...event, prompt: "PRIVATE_PROMPT", last_assistant_message: "PRIVATE_ANSWER", transcript_path: "/not-readable/private-log", extra: "PRIVATE_EXTRA" }, f);
  const directory = path.join(f.root, ".local-state/memory-review");
  const content = fs.readdirSync(directory).map((file) => fs.readFileSync(path.join(directory, file), "utf8")).join("");
  assert.doesNotMatch(content, /PRIVATE_|synthetic-session|synthetic-turn|transcript|prompt|private-log/);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test("missing or pending review fails without creating a visible continuation", (t) => {
  const f = fixture(t);
  for (const prepared of [false, true]) {
    if (prepared) start(f.root, event, f);
    for (let i = 0; i < 3; i++) {
      const result = stopReview(f.root, event, f);
      assert.equal(result.continue, false);
      assert.match(result.systemMessage, /MEMORY_REVIEW_FAILED/);
      assert.equal(result.decision, undefined);
      assert.equal(result.reason, undefined);
      assert.equal(result.hookSpecificOutput, undefined);
    }
  }
});

test("repeated prompt delivery preserves the checkpoint and does not erase a completed review", (t) => {
  const f = fixture(t);
  const result = start(f.root, event, f);
  assert.deepEqual(start(f.root, event, f), result);
  completeReview(f.root, tokenOf(result), "no_durable_discovery", f);
  assert.deepEqual(start(f.root, event, f), result);
  assert.deepEqual(stopReview(f.root, event, f), {});
  assert.throws(() => completeReview(f.root, tokenOf(result), "no_durable_discovery", f), /already closed/);
});

test("stale receipt and changes after review cannot authorize completion", (t) => {
  const f = fixture(t);
  const result = start(f.root, event, f);
  completeReview(f.root, tokenOf(result), "already_current", f);
  fs.appendFileSync(path.join(f.root, target), "\nConcurrent public note.\n");
  assert.equal(stopReview(f.root, event, f).continue, false);
  completeReview(f.root, tokenOf(result), "updated", f);
  assert.deepEqual(stopReview(f.root, event, f), {});
  start(f.root, { ...event, turn_id: "new-user-turn" }, f);
  assert.throws(() => completeReview(f.root, tokenOf(result), "already_current", f), /stale/);
});

test("evidence drift and unverified outcome never report a clean review", (t) => {
  const f = fixture(t);
  applyCandidate(f.root, f.candidate(), { ...f, apply: true });
  const result = start(f.root, event, f);
  fs.appendFileSync(path.join(f.root, source), "// changed\n");
  assert.throws(() => completeReview(f.root, tokenOf(result), "already_current", f), /validation failed/);
  fs.writeFileSync(path.join(f.root, source), 'export const adapter = "blue";\n');
  completeReview(f.root, tokenOf(result), "unverified", f);
  assert.equal(stopReview(f.root, event, f).continue, false);
});

test("missing hook identity fails explicitly and unrelated events do nothing", (t) => {
  const f = fixture(t);
  assert.equal(stopReview(f.root, { hook_event_name: "Stop" }, f).continue, false);
  assert.equal(startReview(f.root, { hook_event_name: "UserPromptSubmit" }, f).continue, false);
  assert.deepEqual(startReview(f.root, event, f), {});
  assert.deepEqual(stopReview(f.root, { hook_event_name: "PostToolUse" }, f), {});
});

test("versioned hooks prepare internal context and verify at Stop with bounded timeouts", () => {
  const hooks = JSON.parse(fs.readFileSync(new URL("../.codex/hooks.json", import.meta.url)));
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  const prepare = hooks.hooks.UserPromptSubmit[0].hooks[0];
  assert.match(prepare.command, /scripts\/memory-review\.mjs.*hook/);
  assert.ok(prepare.timeout <= 15);
  assert.ok(prepare.additionalContextLimit >= 1000);
  assert.equal(prepare.statusMessage, undefined);
  assert.equal(hooks.hooks.Stop[0].hooks[0].statusMessage, undefined);
  assert.equal(hooks.hooks.Stop.length, 1);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /scripts\/memory-review\.mjs.*hook/);
  assert.ok(hooks.hooks.Stop[0].hooks[0].timeout <= 15);
  assert.equal(hooks.hooks.PostToolUse.length, 1);
});
