import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function createDockerRecoveryStore(root) {
  const current = path.join(root, ".local-secrets", "docker-update-recovery.json");
  const legacy = path.join(root, ".local-state", "docker-update-recovery.json");
  const history = path.join(root, ".local-secrets", "docker-update-history");
  const syncDirectory = directory => {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const write = (file, value) => {
    const raw = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(raw) > 131072) throw new Error("Docker recovery record exceeds its size bound");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600);fs.writeFileSync(fd, raw);fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);syncDirectory(path.dirname(file));
  };
  return {
    current, legacy, history,
    hasPending: () => [current, legacy, `${current}.tmp`, `${legacy}.tmp`].some(file => fs.existsSync(file)),
    record: state => write(current, { ...state, recorded_at: new Date().toISOString() }),
    clear: () => {
      const record = JSON.parse(fs.readFileSync(current, "utf8"));
      const completed = { ...record, status: "verified", verified_at: new Date().toISOString() };
      const identity = crypto.createHash("sha256").update(JSON.stringify(completed)).digest("hex");
      write(path.join(history, `${identity}.json`), completed);
      // A durable completion receipt exists before releasing the active gate.
      fs.unlinkSync(current);syncDirectory(path.dirname(current));
    },
  };
}
