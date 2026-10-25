import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function fixture(t, { installed = false, race = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-idle-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, ".local"), bin = path.join(prefix, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const codex = path.join(bin, "codex"), npm = path.join(root, "npm");
  const restart = path.join(root, "restart"), calls = path.join(root, "installs");
  const busy = path.join(root, "busy"), marker = path.join(prefix, ".codex-cli-restart-required");
  fs.writeFileSync(codex, `#!/bin/sh\necho 'codex-cli ${installed ? "0.2.0" : "0.1.0"}'\n`);
  fs.writeFileSync(npm, `#!/bin/sh
if [ "$1" = view ]; then echo 0.2.0; exit 0; fi
printf 'install\\n' >> '${calls}'
printf '#!/bin/sh\\necho codex-cli 0.2.0\\n' > '${codex}'
chmod 0755 '${codex}'
`);
  fs.writeFileSync(restart, `#!/bin/sh
if [ "$1" = --preflight-restart ]; then
  ${race ? `[ ! -f '${busy}' ] && exit 0` : "true"}
  exit 75
fi
touch '${busy}'
exit 75
`);
  for (const file of [codex, npm, restart]) fs.chmodSync(file, 0o755);
  if (installed) fs.writeFileSync(marker, "");
  const env = { ...process.env, CODEX_CLI_NPM_BIN: npm, CODEX_CLI_BIN: codex,
    CODEX_CLI_PREFIX: prefix, CODEX_CLI_REMOTE_RESTART_BIN: restart,
    CODEX_CLI_RESTART_MARKER: marker };
  return { codex, calls, busy, marker,
    run: () => spawnSync("sh", ["scripts/update-codex-cli.sh"], { env, encoding: "utf8" }) };
}

test("busy daemon defers before binary installation, marker creation or restart", t => {
  const f = fixture(t), before = fs.readFileSync(f.codex);
  const result = f.run();
  assert.equal(result.status, 75); assert.match(result.stdout, /status=deferred/);
  assert.deepEqual(fs.readFileSync(f.codex), before);
  assert.equal(fs.existsSync(f.calls), false); assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(f.busy), false);
});

test("deferred pending restart preserves the installed binary and marker", t => {
  const f = fixture(t, { installed: true }), before = fs.readFileSync(f.codex);
  assert.equal(f.run().status, 75);
  assert.equal(fs.existsSync(f.marker), true); assert.equal(fs.existsSync(f.calls), false);
  assert.deepEqual(fs.readFileSync(f.codex), before);
});

test("work appearing after install defers restart without repeating installation", t => {
  const f = fixture(t, { race: true });
  assert.equal(f.run().status, 75); assert.equal(fs.existsSync(f.marker), true);
  assert.equal(f.run().status, 75); assert.equal(fs.existsSync(f.marker), true);
  assert.deepEqual(fs.readFileSync(f.calls, "utf8").trim().split("\n"), ["install"]);
});
