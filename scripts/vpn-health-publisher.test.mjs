import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectVpnHealth,
  evaluateTailscaleStatus,
  VPN_HEALTH_TOPIC,
} from "./vpn-health-publisher.mjs";

test("classifies a connected Tailscale daemon without retaining private topology", () => {
  const report = evaluateTailscaleStatus(JSON.stringify({
    BackendState: "Running",
    Self: { Online: true, HostName: "private-host", TailscaleIPs: ["synthetic-address"] },
    Peer: { private: { Online: true, HostName: "private-peer" } },
  }), "2026-08-30T15:00:00.000Z");
  assert.deepEqual(report, {
    role: "vpn_primary",
    kind: "tailscale",
    installed: true,
    healthy: true,
    status: "online",
    reason: "running",
    checked_at: "2026-08-30T15:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(report), /private|synthetic-address/);
});

test("classifies authentication and command failures without leaking stderr", () => {
  assert.equal(evaluateTailscaleStatus({
    BackendState: "NeedsLogin",
    Self: { Online: false },
  }).reason, "authentication_required");

  const report = collectVpnHealth({
    now: new Date("2026-08-30T15:01:00.000Z"),
    run: () => ({ status: 1, stderr: "secret host and address" }),
  });
  assert.equal(report.vpns[0].healthy, false);
  assert.equal(report.vpns[0].reason, "status_command_failed");
  assert.doesNotMatch(JSON.stringify(report), /secret host/);
});

test("reports no supported VPN when Tailscale is not installed", () => {
  const report = collectVpnHealth({
    run: () => ({ error: { code: "ENOENT" }, status: null }),
  });
  assert.equal(report.supported_vpn_count, 0);
  assert.deepEqual(report.vpns, []);
});

test("cron installer exposes one bounded retained MQTT publisher", () => {
  const installer = fileURLToPath(new URL("./install-vpn-health-monitor-cron.sh", import.meta.url));
  const output = execFileSync("sh", [installer, "--dry-run"], { encoding: "utf8" });
  assert.equal((output.match(/BEGIN Smart home VPN health publisher/g) ?? []).length, 1);
  assert.match(output, /flock -n/);
  assert.match(output, /vpn-health-publisher\.mjs --publish/);
  assert.equal(VPN_HEALTH_TOPIC, "nodered/infrastructure/vpn/host-health");
});

test("summarizes key expiry without names, addresses or users", () => {
  const raw = JSON.stringify({
    BackendState: "Running",
    Self: { Online: true, HostName: "private-host", OS: "linux", KeyExpiry: "2027-03-04T00:16:18Z" },
    Peer: {
      a: { HostName: "private-phone", OS: "iOS", UserID: 7, KeyExpiry: "2027-05-26T22:10:51Z" },
      b: { HostName: "private-shared", OS: "", ShareeNode: true, KeyExpiry: "2026-12-11T22:49:46Z" },
      c: { HostName: "funnel-ingress-node" },
    },
  });
  const report = collectVpnHealth({ run: () => ({ status: 0, stdout: raw }) });
  assert.deepEqual(report.key_expiry, [
    { scope: "device", platform: "other", shared: true, expires_at: "2026-12-11T22:49:46.000Z" },
    { scope: "host", platform: "linux", shared: false, expires_at: "2027-03-04T00:16:18.000Z" },
    { scope: "device", platform: "ios", shared: false, expires_at: "2027-05-26T22:10:51.000Z" },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private|funnel|UserID/);
});
