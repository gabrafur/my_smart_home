#!/bin/sh
set -eu

status_path="${KIA_UVO_MERGE_STATUS_PATH:-/run/kia-uvo-merge/status.json}"

case "$status_path" in
  /*) ;;
  *) echo "KIA_UVO_MERGE_STATUS_PATH must be absolute" >&2; exit 64 ;;
esac

# An absent status is normal before the first conflict reaches the merge
# worker. Emit nothing in that case so Node-RED does not manufacture an
# availability incident during startup.
[ -e "$status_path" ] || exit 0
[ -r "$status_path" ] || { echo "Kia UVO Codex merge status is unreadable" >&2; exit 66; }

# Publish only the lifecycle fields required by Node-RED. In particular, do
# not forward the worker's free-form failure reason, which can include
# operational detail from the isolated Codex runtime.
node - "$status_path" <<'NODE'
const fs = require("node:fs");

const statusPath = process.argv[2];
let result = { state: "unknown", target: "unknown", updated_at: "unknown" };
try {
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  const state = String(parsed?.state ?? "unknown");
  const target = String(parsed?.target ?? "unknown");
  const updatedAt = String(parsed?.updated_at ?? parsed?.finished_at ?? "unknown");
  result = {
    state: /^(waiting|running|success|failed)$/.test(state) ? state : "unknown",
    target: /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/.test(target) ? target : "unknown",
    updated_at: /^[0-9T:.+-]+Z?$/.test(updatedAt) ? updatedAt : "unknown",
  };
} catch {
  // The consumer treats state=unknown as a production error and sends it to
  // the global observer. Keep this bridge output free of parser detail.
}
console.log(
  `kia-uvo-codex-merge state=${result.state} target=${result.target} updated_at=${result.updated_at}`,
);
NODE
