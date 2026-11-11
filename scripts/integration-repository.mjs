// Reviewed fixed-repository adapter. Forward installs use update.install.
// Rollback runs only with HA stopped, without network, and restores one record.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(new URL("./integration_repository.py", import.meta.url), "utf8");
const repositories = new Set(["alandtse/alexa_media_player", "Hyundai-Kia-Connect/kia_uvo"]);

function payload(repository, mode, extra = {}) {
  if (!repositories.has(repository)) throw new Error("repository_not_reviewed");
  return JSON.stringify({ repository, mode, ...extra });
}

function execute(args, input, command = execFileSync) {
  return JSON.parse(command("docker", args, {
    cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  }));
}

export function readRepositoryRecord(repository, command = execFileSync) {
  return execute(["exec", "-i", "homeassistant", "python", "-I", "-B", "-c", source],
    payload(repository, "read"), command);
}

export function snapshotRepository(repository, backupDir, command = execFileSync) {
  const before = execute(["exec", "-i", "homeassistant", "python", "-I", "-B", "-c", source],
    payload(repository, "snapshot"), command);
  fs.writeFileSync(path.join(backupDir, "repository-before.json"), `${JSON.stringify(before)}\n`, { mode: 0o600, flag: "wx" });
  return before;
}

export function restoreRepository(repository, backupDir, target, command = execFileSync,
  storage = path.join(root, "homeassistant/.storage")) {
  const input = payload(repository, "restore", {
    before: JSON.parse(fs.readFileSync(path.join(backupDir, "repository-before.json"))), target,
  });
  const inspect = (format) => command("docker", ["inspect", "--format", format, "homeassistant"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  }).trim();
  if (inspect("{{.State.Running}}") !== "false") throw new Error("repository_restore_requires_stopped_homeassistant");
  const image = inspect("{{.Image}}");
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("repository_restore_image_unconfirmed");
  if (fs.realpathSync(storage) !== storage) throw new Error("repository_storage_symlink_refused");
  return execute(["run", "--rm", "-i", "--network", "none", "--read-only", "--cap-drop=ALL",
    "--security-opt", "no-new-privileges", "--memory", "128m", "--cpus", "0.25", "--pids-limit", "16",
    "--ulimit", "cpu=4:4",
    "--mount", `type=bind,source=${storage},target=/config/.storage`, "--entrypoint", "python", image,
    "-I", "-B", "-c", source], input, command);
}
