import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import {
  applyRestore,
  assertSafeDestination,
  backupPlan,
  createSyntheticBundle,
  loadManifest,
  repoRoot,
  restorePlan,
  verifyBundle,
} from "./restore.mjs";

function item(logicalName, kind, destination, order, dependencies = [], required = true) {
  return {
    logical_name: logicalName,
    component: "synthetic",
    module: "core",
    kind,
    source: destination,
    destination,
    required,
    required_when_module_enabled: false,
    criticality: "high",
    owner: "synthetic_owner",
    group: "synthetic_group",
    permissions: kind === "directory" ? "0700" : "0600",
    consistency_mode: kind === "directory" ? "offline-copy" : "atomic-file-copy",
    service_must_be_stopped: ["synthetic-service"],
    dependencies,
    restore_order: order,
    fresh_install_behavior: "create synthetic state",
    restore_behavior: "restore only inside a synthetic canary",
    checksum_policy: "sha256-every-file",
    validation: ["synthetic assertion"],
    git_policy: "ignored-private-state",
  };
}

function manifest() {
  return {
    schema_version: 1,
    contract: "private-state-v1",
    bundle: {
      metadata_file: "bundle.json",
      manifest_file: "manifest.yaml",
      checksums_file: "checksums.json",
      components_directory: "components",
      encryption_required: true,
    },
    items: [
      item("synthetic_file", "file", ".synthetic/core.txt", 10),
      item("synthetic_directory", "directory", ".synthetic/state", 20, ["synthetic_file"]),
      item("synthetic_optional", "file", ".synthetic/optional.txt", 30, ["synthetic_file"], false),
    ],
  };
}

function fixture(t, payloads = {
  synthetic_file: "synthetic core value\n",
  synthetic_directory: { "nested/state.json": "{\"synthetic\":true}\n" },
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestFile = path.join(root, "canonical-manifest.yaml");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest(), null, 2)}\n`);
  const bundleDir = path.join(root, "bundle");
  createSyntheticBundle(bundleDir, manifest(), payloads);
  return { root, manifestFile, bundleDir };
}

test("public private-state manifest validates against the versioned schema", () => {
  const publicManifest = loadManifest();
  assert.equal(publicManifest.contract, "private-state-v1");
  assert.ok(publicManifest.items.length >= 10);
});

test("every local private-state destination is ignored and untracked", () => {
  const publicManifest = loadManifest();
  for (const item of publicManifest.items.filter((entry) => !entry.kind.startsWith("external-"))) {
    assert.throws(() => execFileSync("git", ["ls-files", "--error-unmatch", "--", item.destination], {
      cwd: repoRoot,
      stdio: "ignore",
    }));
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", item.destination], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  }
});

test("backup plan is metadata-only and masks physical paths", () => {
  const plan = backupPlan();
  assert.equal(plan.read_private_content, false);
  assert.equal(plan.copies_data, false);
  assert.ok(plan.components.every((component) => component.source.startsWith("<private>/")));
});

test("synthetic bundle verifies, plans and restores in declared order", (t) => {
  const { root, manifestFile, bundleDir } = fixture(t);
  const destination = path.join(root, "synthetic-restore-target");
  const verified = verifyBundle(bundleDir, { canonicalManifestFile: manifestFile });
  assert.equal(verified.valid, true);
  assert.equal(verified.components, 2);
  const plan = restorePlan(bundleDir, { destination, canonicalManifestFile: manifestFile });
  assert.equal(plan.writes_data, false);
  assert.equal(plan.capacity.sufficient, true);
  const applied = applyRestore(bundleDir, destination, {
    confirm: "RESTORE_PRIVATE_STATE",
    canonicalManifestFile: manifestFile,
    repositoryRoot: path.join(root, "unrelated-repository"),
  });
  assert.deepEqual(applied.restored, ["synthetic_file", "synthetic_directory"]);
  assert.equal(fs.readFileSync(path.join(destination, ".synthetic/core.txt"), "utf8"), "synthetic core value\n");
  assert.equal(fs.readFileSync(path.join(destination, ".synthetic/state/nested/state.json"), "utf8"), "{\"synthetic\":true}\n");
  assert.equal(fs.statSync(path.join(destination, ".synthetic/core.txt")).mode & 0o777, 0o600);
  assert.equal(applied.rollback_snapshot_prepared, true);
});

test("checksum corruption is rejected", (t) => {
  const { manifestFile, bundleDir } = fixture(t);
  fs.appendFileSync(path.join(bundleDir, "components/synthetic_file/payload"), "corruption");
  assert.throws(() => verifyBundle(bundleDir, { canonicalManifestFile: manifestFile }), /byte count|checksum/);
});

test("non-private payload permissions are rejected", (t) => {
  const { manifestFile, bundleDir } = fixture(t);
  const checksumsFile = path.join(bundleDir, "checksums.json");
  const checksums = JSON.parse(fs.readFileSync(checksumsFile, "utf8"));
  checksums.files[0].mode = "0644";
  fs.writeFileSync(checksumsFile, `${JSON.stringify(checksums, null, 2)}\n`);
  assert.throws(() => verifyBundle(bundleDir, { canonicalManifestFile: manifestFile }), /permissions are not private/);
});

test("unknown modules and unencrypted non-synthetic bundles are rejected", (t) => {
  const { manifestFile, bundleDir } = fixture(t);
  const metadataFile = path.join(bundleDir, "bundle.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  metadata.enabled_modules.push("unknown-module");
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.throws(() => verifyBundle(bundleDir, { canonicalManifestFile: manifestFile }), /unknown module/);

  metadata.enabled_modules = ["core"];
  metadata.repository_commit = "0".repeat(40);
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.throws(() => verifyBundle(bundleDir, { canonicalManifestFile: manifestFile }), /unencrypted bundles/);
});

test("missing required component is rejected", (t) => {
  const { manifestFile, bundleDir } = fixture(t, { synthetic_file: "only one\n" });
  assert.throws(() => verifyBundle(bundleDir, { canonicalManifestFile: manifestFile }), /required bundle component missing/);
});

test("bundle cannot replace the canonical destination contract", (t) => {
  const { manifestFile, bundleDir } = fixture(t);
  const bundleManifestFile = path.join(bundleDir, "manifest.yaml");
  const changed = JSON.parse(fs.readFileSync(bundleManifestFile, "utf8"));
  changed.items[0].destination = ".synthetic/unexpected.txt";
  fs.writeFileSync(bundleManifestFile, `${JSON.stringify(changed, null, 2)}\n`);
  const metadataFile = path.join(bundleDir, "bundle.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  metadata.manifest_sha256 = crypto.createHash("sha256").update(fs.readFileSync(bundleManifestFile)).digest("hex");
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.throws(() => verifyBundle(bundleDir, { canonicalManifestFile: manifestFile }), /contract mismatch/);
});

test("dangerous destinations are rejected", () => {
  assert.throws(() => assertSafeDestination("/"), /dangerous/);
  assert.throws(() => assertSafeDestination(os.homedir()), /dangerous/);
  assert.throws(() => assertSafeDestination(repoRoot), /dangerous/);
  assert.throws(() => assertSafeDestination(path.join(os.tmpdir(), "ordinary-target")), /additional confirmation/);
});

test("a symlink anywhere in the restore destination is rejected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-test-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  const linked = path.join(root, "restore-canary-link");
  fs.symlinkSync(real, linked);
  assert.throws(() => assertSafeDestination(linked), /symlink/);
});

test("restore apply requires the explicit confirmation token", (t) => {
  const { root, manifestFile, bundleDir } = fixture(t);
  assert.throws(() => applyRestore(bundleDir, path.join(root, "restore-canary-confirmation"), {
    confirm: "NO",
    canonicalManifestFile: manifestFile,
    repositoryRoot: path.join(root, "unrelated-repository"),
  }), /explicit restore confirmation/);
});

test("synthetic apply failure restores the previous snapshot", (t) => {
  const { root, manifestFile, bundleDir } = fixture(t);
  const destination = path.join(root, "restore-canary-rollback");
  const oldFile = path.join(destination, ".synthetic/core.txt");
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, "previous value\n", { mode: 0o600 });
  assert.throws(() => applyRestore(bundleDir, destination, {
    confirm: "RESTORE_PRIVATE_STATE",
    canonicalManifestFile: manifestFile,
    faultAfter: 1,
    repositoryRoot: path.join(root, "unrelated-repository"),
  }), /rolled back/);
  assert.equal(fs.readFileSync(oldFile, "utf8"), "previous value\n");
  assert.equal(fs.existsSync(path.join(destination, ".synthetic/state")), false);
});
