#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flows = JSON.parse(fs.readFileSync(path.resolve(here, "..", "flows.json"), "utf8"));
const node = (id) => {
  const found = flows.find((entry) => entry.id === id);
  assert.ok(found, `missing node ${id}`);
  return found;
};

assert.equal(node("daily_host_updates_tab").label, "atualizacoes_diarias");
assert.equal(node("git_backup_tab").label, "backup_git");
assert.deepEqual(node("git_backup_daily_update_out").links, ["daily_update_after_backup_in"]);
assert.deepEqual(node("daily_update_after_backup_in").links, ["git_backup_daily_update_out"]);
assert.equal(node("global_observer_coverage__daily_host_updates_tab__catch").type, "catch");
assert.deepEqual(node("global_observer_coverage__daily_host_updates_tab__out").links, ["global_observer_events_in"]);
assert.equal(node("daily_update_request_host").command, "/opt/request-host-daily-update.sh");
assert.equal(node("daily_update_read_result").command, "/opt/read-host-daily-update-result.sh");
assert.equal(node("daily_update_result_poll").repeat, "300");
assert.equal(node("daily_update_result_startup").once, true);
assert.equal(flows.filter((entry) => entry.z === "daily_host_updates_tab" && entry.crontab).length, 0);

const serializedProduction = JSON.stringify([
  node("daily_update_request_host"),
  node("daily_update_read_result"),
]);
assert.ok(!serializedProduction.includes("docker.sock"));
assert.ok(!serializedProduction.includes("sudo"));
assert.ok(!serializedProduction.includes("apt-get"));
assert.ok(!serializedProduction.includes("/mnt/data/docker"));

assert.deepEqual(node("daily_update_route_test").wires, [
  ["daily_update_request_test_out"],
  ["daily_update_request_host"],
]);
assert.deepEqual(node("daily_update_test_request").wires, [["daily_update_test_request_out"]]);
assert.deepEqual(node("daily_update_test_failure").wires, [["daily_update_test_result_out"]]);
assert.deepEqual(node("daily_update_test_unavailable").wires, [["daily_update_test_result_out"]]);
assert.ok(!JSON.stringify([
  node("daily_update_test_request"),
  node("daily_update_test_failure"),
  node("daily_update_test_unavailable"),
]).includes("daily_update_request_host"));
assert.match(node("daily_update_dry_run_terminal").func, /simulated: true/);
assert.match(node("daily_update_dry_run_terminal").func, /dispatched: false/);
assert.match(node("daily_update_dry_run_terminal").func, /apt_commands_sent: false/);
assert.match(node("daily_update_dry_run_terminal").func, /docker_update_sent: false/);
assert.deepEqual(node("daily_update_dry_run_terminal").wires, []);

const values = new Map();
const flow = {
  get(key) { return values.get(key); },
  set(key, value) { values.set(key, value); },
};
const statuses = [];
const errors = [];
const runtimeNode = {
  status(value) { statuses.push(value); },
  warn() {},
  error(value) { errors.push(value); },
};
const prepare = new Function("msg", "node", "flow", node("daily_update_prepare_request").func);
assert.equal(prepare(
  { payload: { event: "git_backup_completed", status: "failed" } },
  runtimeNode,
  flow,
), null);
const prepared = prepare(
  { payload: { event: "git_backup_completed", status: "success", finished_at: "synthetic" } },
  runtimeNode,
  flow,
);
assert.equal(prepared.payload.event, "daily_update_requested");
assert.equal(prepared.payload.source, "git_backup");
assert.equal(prepared._daily_update_test, false);

const preparedTest = prepare(
  { _daily_update_test: true, payload: { event: "git_backup_completed", status: "success", test_mode: true } },
  runtimeNode,
  flow,
);
assert.equal(preparedTest.payload.test_mode, true);

const parse = new Function("msg", "node", "flow", node("daily_update_parse_result").func);
const testFailure = parse(
  { _daily_update_test: true, payload: "daily-update status=failed request_id=test dietpi_exit=100 dietpi_stage=dietpi-update containers_exit=0" },
  runtimeNode,
  flow,
);
assert.equal(testFailure.payload.status, "failed");
assert.equal(testFailure.payload.dietpi_exit, 100);
assert.equal(testFailure.payload.dietpi_stage, "dietpi-update");
assert.equal(errors.length, 0, "synthetic failures must not alert production observers");

const productionFailure = parse(
  { payload: "daily-update status=failed request_id=prod dietpi_exit=100 dietpi_stage=dietpi-update containers_exit=0" },
  runtimeNode,
  flow,
);
assert.equal(productionFailure, null);
assert.match(errors.at(-1), /daily_update_failed/);
assert.match(errors.at(-1), /dietpi_stage=dietpi-update/);

const productionDuplicate = parse(
  { payload: "daily-update status=failed request_id=prod dietpi_exit=100 dietpi_stage=dietpi-update containers_exit=0" },
  runtimeNode,
  flow,
);
assert.equal(productionDuplicate, null);
assert.equal(errors.length, 1, "duplicate results must be deduplicated");

const compose = fs.readFileSync(path.resolve(here, "..", "..", "docker-compose.yml"), "utf8");
assert.match(compose, /\.\/homeassistant\/\.daily-update-trigger:\/run\/daily-update-trigger/);
assert.match(compose, /request-host-daily-update\.sh:\/opt\/request-host-daily-update\.sh:ro/);
assert.match(compose, /read-host-daily-update-result\.sh:\/opt\/read-host-daily-update-result\.sh:ro/);

console.log("Daily host update flow contracts are valid");
