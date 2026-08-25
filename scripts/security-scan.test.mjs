import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scanner = fs.readFileSync(path.join(repositoryRoot, "scripts", "security-scan.sh"), "utf8");
const ignore = fs.readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8");

function run(cwd, executable, args) {
  return spawnSync(executable, args, { cwd, encoding: "utf8" });
}

function git(cwd, args) {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "security-scan-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Synthetic Security Fixture"]);
  git(root, ["config", "user.email", "security@example.invalid"]);
  write(root, ".gitignore", ignore);
  write(root, "scripts/security-scan.sh", scanner);
  write(root, ".env.example", "SAFE_EXAMPLE=CHANGE_ME\n");
  write(root, "safe.txt", "safe synthetic fixture\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "synthetic baseline"]);
  return {
    root,
    scan(args = []) {
      return run(root, "bash", ["scripts/security-scan.sh", ...args]);
    },
  };
}

test("passes a safe tracked tree", () => {
  const item = fixture();
  const result = item.scan();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nenhum segredo/);
});

test("allows exact detector definitions without allowing a private key fixture", () => {
  const item = fixture();
  write(item.root, "scripts/public-memory-check.mjs", 'const patterns = [["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g]];\n');
  write(item.root, "scripts/local-ai/post_tool_routing.py", 'SECRET_BLOCK = r"-----BEGIN [^-\\n]*PRIVATE KEY-----[\\s\\S]*?-----END [^-\\n]*PRIVATE KEY-----",\n');
  git(item.root, ["add", "scripts/public-memory-check.mjs", "scripts/local-ai/post_tool_routing.py"]);
  assert.equal(item.scan(["--staged"]).status, 0);

  const synthetic = ["-----BEGIN ", "TEST PRIVATE KEY-----"].join("");
  write(item.root, "scripts/public-memory-check.mjs", `${synthetic}\n`);
  git(item.root, ["add", "scripts/public-memory-check.mjs"]);
  const result = item.scan(["--staged"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rule=chave-privada file=scripts\/public-memory-check\.mjs/);
  assert.equal(result.stdout.includes(synthetic), false);
});

test("detects a synthetic credential without printing any fragment", () => {
  const item = fixture();
  const value = ["ghp", "_", "A".repeat(32)].join("");
  write(item.root, "credential.txt", `${value}\n`);
  git(item.root, ["add", "credential.txt"]);
  git(item.root, ["commit", "-qm", "synthetic credential fixture"]);
  const result = item.scan();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rule=github-token file=credential\.txt line=1 category=secret-or-private-data/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(value.slice(0, 12)), false);
});

test("detects forbidden runtime state by path", () => {
  const item = fixture();
  write(item.root, "homeassistant/.storage/state.json", "{}\n");
  git(item.root, ["add", "-f", "homeassistant/.storage/state.json"]);
  git(item.root, ["commit", "-qm", "synthetic forbidden path fixture"]);
  const result = item.scan();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /arquivo-proibido.*homeassistant\/\.storage\/state\.json/);
});

test("detects private network and physical-location categories", () => {
  const item = fixture();
  const address = ["10", "23", "45", "67"].join(".");
  const mac = ["00", "11", "22", "33", "44", "55"].join(":");
  const coordinate = ["-23", "1234567"].join(".");
  write(item.root, "private-data.txt", `host=${address}\ndevice=${mac}\nlatitude=${coordinate}\n`);
  git(item.root, ["add", "private-data.txt"]);
  git(item.root, ["commit", "-qm", "synthetic private data fixture"]);
  const result = item.scan();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rule=ipv4-privado/);
  assert.match(result.stdout, /rule=mac-address/);
  assert.match(result.stdout, /rule=coordenada-(?:precisa|nua)/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(address), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(mac), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(coordinate), false);
});

test("allows benchmark metrics without weakening other artifact checks", () => {
  const item = fixture();
  const metric = ["0", "903125"].join(".");
  const artifacts = [
    "docs/benchmarks/local-ai-high-potential/latest.json",
    "docs/benchmarks/local-ai-restricted-pivot/retrieval-reranking/latest.json",
    "docs/benchmarks/local-ai-structured-extraction-canary/readiness.json",
  ];
  for (const artifact of artifacts) {
    write(item.root, artifact, `{"quality_score":${metric}}\n`);
    git(item.root, ["add", artifact]);
  }
  assert.equal(item.scan(["--staged"]).status, 0);

  const address = ["10", "23", "45", "67"].join(".");
  write(item.root, artifacts[1], `{"quality_score":${metric},"endpoint":"${address}"}\n`);
  git(item.root, ["add", artifacts[1]]);
  const result = item.scan(["--staged"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rule=ipv4-privado/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(address), false);
});

test("tracked mode ignores untracked content and staged mode inspects the index", () => {
  const item = fixture();
  const value = ["ghp", "_", "B".repeat(32)].join("");
  write(item.root, "untracked.txt", `${value}\n`);
  assert.equal(item.scan().status, 0);
  git(item.root, ["add", "untracked.txt"]);
  const staged = item.scan(["--staged"]);
  assert.equal(staged.status, 1);
  assert.match(staged.stdout, /file=untracked\.txt/);
});
