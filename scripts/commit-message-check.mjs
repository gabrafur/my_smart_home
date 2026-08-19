#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedTypes = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "test"];
const portugueseActionWords = new Set([
  "adiciona", "adicionar", "ajusta", "ajustar", "atualiza", "atualizar",
  "corrige", "corrigir", "cria", "criar", "documenta", "documentar",
  "endurece", "endurecer", "esclarece", "esclarecer", "evita", "evitar",
  "melhora", "melhorar", "organiza", "organizar", "preenche", "preencher",
  "recupera", "recuperar", "renomeia", "renomear", "traduz", "traduzir",
  "torna", "tornar",
]);
const conventionalSubject = new RegExp(
  `^(?:${allowedTypes.join("|")})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: ([a-z0-9].*)$`,
);

export function validateCommitSubject(subject) {
  const errors = [];
  if (subject.length > 72) errors.push("subject exceeds 72 characters");
  if (!conventionalSubject.test(subject)) {
    errors.push("expected '<type>[(optional-scope)][!]: <lowercase description>'");
  }
  const descriptionFirstWord = subject.match(/^[^:]+: ([^\s]+)/)?.[1].toLocaleLowerCase("pt-BR");
  if (portugueseActionWords.has(descriptionFirstWord)) {
    errors.push(`description starts with Portuguese action word '${descriptionFirstWord}'`);
  }
  if (/[.!?]$/.test(subject)) errors.push("subject must not end with punctuation");
  return errors;
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function checkSubject(subject) {
  const errors = validateCommitSubject(subject);
  if (errors.length) {
    for (const error of errors) console.error(`commit-message-check: ${error}: ${subject}`);
    return false;
  }
  console.log(`Commit message passed: ${subject}`);
  return true;
}

function checkRevisions(revision) {
  const commits = revision.includes("..")
    ? git(["rev-list", "--reverse", revision]).split("\n").filter(Boolean)
    : [git(["rev-parse", "--verify", `${revision}^{commit}`])];
  let valid = true;
  for (const commit of commits) {
    const parents = git(["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean);
    if (parents.length > 1) continue;
    const subject = git(["show", "-s", "--format=%s", commit]);
    valid = checkSubject(subject) && valid;
  }
  return valid;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const valid = args[0] === "--subject"
      ? args.length === 2 && checkSubject(args[1])
      : args.length <= 1 && checkRevisions(args[0] || "HEAD");
    if (!valid) process.exitCode = 1;
  } catch (error) {
    console.error(`commit-message-check: ${error.message}`);
    process.exitCode = 1;
  }
}
