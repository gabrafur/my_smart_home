#!/bin/sh
set -eu

status_path="${KIA_UVO_PROMOTION_PUBLIC_STATUS_PATH:-/run/kia-uvo-merge/promotion-public-status.json}"

case "$status_path" in
  /*) ;;
  *) echo "KIA_UVO_PROMOTION_PUBLIC_STATUS_PATH must be absolute" >&2; exit 64 ;;
esac

# No promotion exists until the isolated worker prepares a candidate. That is
# expected at startup and must not be turned into a Node-RED incident.
[ -e "$status_path" ] || exit 0
[ -r "$status_path" ] || { echo "Kia UVO promotion status is unreadable" >&2; exit 66; }

# Keep the bridge deliberately narrow. Free-form failure reasons can contain
# host operational detail that does not belong in the Node-RED runtime.
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
    state: /^(deferred|applying|runtime_applied|applied_pending_git|main_published|completed|failed)$/.test(state) ? state : "unknown",
    target: /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/.test(target) ? target : "unknown",
    updated_at: /^[0-9T:.+-]+Z?$/.test(updatedAt) ? updatedAt : "unknown",
  };
} catch {
  // The consumer routes state=unknown through the global observer without
  // exposing parser or filesystem detail from the host.
}
console.log(`kia-uvo-promotion state=${result.state} target=${result.target} updated_at=${result.updated_at}`);
NODE
