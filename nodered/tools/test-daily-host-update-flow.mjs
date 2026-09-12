#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flowsPath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
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
assert.equal(node("daily_update_request_host").command, "/opt/request-host-update-stage.sh dietpi");
assert.equal(node("daily_update_read_result").command, "/opt/read-host-update-stage-result.sh dietpi");
assert.equal(node("daily_update_result_poll").repeat, "300");
assert.equal(node("daily_update_result_startup").once, true);
assert.deepEqual(
  flows.filter((entry) => entry.z === "daily_host_updates_tab" && entry.crontab).map((entry) => entry.id),
  [],
);
assert.equal(node("daily_update_inventory_schedule").crontab, "");
assert.equal(node("daily_update_inventory_schedule").once, true);
assert.equal(node("daily_update_inventory_schedule_delay").pauseType, "delayv");
assert.match(
  node("daily_update_inventory_schedule_delay_value").rules[0].to,
  /update_policy\.scan_interval_minutes.*60000/,
);
assert.deepEqual(node("daily_update_inventory_schedule_loop_out").links, ["daily_update_inventory_schedule_loop_in"]);
assert.deepEqual(node("daily_update_inventory_schedule_loop_in").links, ["daily_update_inventory_schedule_loop_out"]);
assert.equal(node("daily_update_kia_schedule").type, "link in");
assert.deepEqual(node("daily_update_kia_schedule").links, ["daily_update_inventory_kia_out"]);
assert.equal(node("daily_update_kia_request_host").command, "/opt/request-host-kia-uvo-update-check.sh");
assert.ok(node("git_backup_daily_update_out").links.includes("daily_update_after_backup_in"));
assert.equal(node("daily_update_kia_read_result").command, "/opt/read-host-kia-uvo-update-result.sh");
assert.equal(node("daily_update_kia_result_poll").repeat, "60");
assert.equal(node("daily_update_kia_parse_result").outputs, 2);
assert.deepEqual(node("daily_update_kia_parse_result").wires, [
  ["daily_update_kia_result_test_out"],
  ["daily_update_kia_codex_request_out"],
]);
assert.deepEqual(node("daily_update_kia_codex_request_out").links, ["daily_update_kia_codex_request_in"]);
assert.equal(node("daily_update_kia_codex_request").command, "/opt/request-kia-uvo-codex-merge.sh");
assert.equal(node("daily_update_kia_codex_request").addpay, "payload");
assert.equal(node("daily_update_kia_codex_read_result").command, "/opt/read-kia-uvo-codex-merge-result.sh");
assert.equal(node("daily_update_kia_codex_result_poll").repeat, "60");
assert.equal(node("daily_update_kia_promotion_read_result").command, "/opt/read-kia-uvo-promotion-result.sh");
assert.equal(node("daily_update_kia_promotion_result_poll").repeat, "60");
assert.deepEqual(node("daily_update_kia_route_test").wires, [
  ["daily_update_kia_test_out"],
  ["daily_update_kia_request_host"],
]);
assert.ok(!JSON.stringify([
  node("daily_update_kia_test_request"),
  node("daily_update_kia_test_result"),
]).includes("daily_update_kia_request_host"));
assert.doesNotMatch(JSON.stringify(node("daily_update_kia_request_host")), /update\.install|ha-updates/);

const serializedProduction = JSON.stringify([
  node("daily_update_request_host"),
  node("daily_update_read_result"),
  node("daily_update_core_request_host"),
  node("daily_update_core_read_result"),
  node("daily_update_containers_request_host"),
  node("daily_update_containers_read_result"),
]);
assert.ok(!serializedProduction.includes("docker.sock"));
assert.ok(!serializedProduction.includes("sudo"));
assert.ok(!serializedProduction.includes("apt-get"));
assert.ok(!serializedProduction.includes("/mnt/data/docker"));
assert.equal(node("daily_update_core_request_host").command, "/opt/request-host-update-stage.sh home-assistant-core");
assert.equal(node("daily_update_core_read_result").command, "/opt/read-host-update-stage-result.sh home-assistant-core");
assert.equal(node("daily_update_containers_request_host").command, "/opt/request-host-update-stage.sh containers");
assert.equal(node("daily_update_containers_read_result").command, "/opt/read-host-update-stage-result.sh containers");
assert.deepEqual(node("daily_update_parse_result").wires, [
  ["daily_update_result_test_out"],
  ["daily_update_core_request_out"],
]);
assert.deepEqual(node("daily_update_core_parse_result").wires, [
  ["daily_update_core_result_test_out"],
  ["daily_update_containers_request_out"],
]);

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
assert.match(node("daily_update_dry_run_terminal").func, /home_assistant_core_update_sent: false/);
assert.match(node("daily_update_dry_run_terminal").func, /hacs_update_install_sent: false/);
assert.match(node("daily_update_dry_run_terminal").func, /device_firmware_install_sent: false/);
assert.match(node("daily_update_dry_run_terminal").func, /kia_uvo_update_check_sent: false/);
assert.match(node("daily_update_dry_run_terminal").func, /kia_uvo_codex_merge_requested: false/);
assert.match(node("daily_update_dry_run_terminal").func, /codex_worker_started: false/);
assert.match(node("daily_update_dry_run_terminal").func, /git_push_sent: false/);
assert.deepEqual(node("daily_update_dry_run_terminal").wires, []);

const values = new Map();
const flow = {
  get(key) { return values.get(key); },
  set(key, value) { values.set(key, value); },
};
const statuses = [];
const errors = [];
const errorMessages = [];
const runtimeNode = {
  status(value) { statuses.push(value); },
  warn() {},
  error(value, message) { errors.push(value); errorMessages.push(message); },
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
  { _daily_update_test: true, payload: "host-update stage=dietpi status=failed request_id=test stage_exit=100 failure_stage=dietpi-update" },
  runtimeNode,
  flow,
);
assert.equal(testFailure[0].payload.status, "failed");
assert.equal(testFailure[0].payload.stage_exit, 100);
assert.equal(testFailure[0].payload.failure_stage, "dietpi-update");
assert.equal(testFailure[1], null);
assert.equal(errors.length, 0, "synthetic failures must not alert production observers");

const productionFailure = parse(
  { payload: "host-update stage=dietpi status=failed request_id=prod stage_exit=100 failure_stage=dietpi-update" },
  runtimeNode,
  flow,
);
assert.deepEqual(productionFailure, [null, null]);
assert.match(errors.at(-1), /host_update_stage_failed/);
assert.match(errors.at(-1), /failure_stage=dietpi-update/);

const productionDuplicate = parse(
  { payload: "host-update stage=dietpi status=failed request_id=prod stage_exit=100 failure_stage=dietpi-update" },
  runtimeNode,
  flow,
);
assert.deepEqual(productionDuplicate, [null, null]);
assert.equal(errors.length, 1, "duplicate results must be deduplicated");

const dietpiSuccess = parse(
  { payload: "host-update stage=dietpi status=success request_id=prod-success stage_exit=0" },
  runtimeNode,
  flow,
);
assert.equal(dietpiSuccess[0], null);
assert.equal(dietpiSuccess[1].payload.stage, "dietpi");
const parseCore = new Function("msg", "node", "flow", node("daily_update_core_parse_result").func);
const coreSuccess = parseCore(
  { payload: "host-update stage=home-assistant-core status=success request_id=core-success stage_exit=0" },
  runtimeNode,
  flow,
);
assert.equal(coreSuccess[1].payload.stage, "home-assistant-core");

assert.equal(node("daily_update_inventory_read_ha").type, "ha-api");
assert.equal(node("daily_update_inventory_read_ha").data, '{"type":"get_states"}');
assert.equal(node("daily_update_inventory_state").type, "switch");
for (const id of ["daily_update_hacs_rbe", "daily_update_unknown_rbe", "daily_update_firmware_pending_rbe"]) {
  assert.equal(node(id).type, "rbe");
  assert.equal(node(id).property, "payload.signature");
}
assert.equal(node("daily_update_inventory_classify").type, "switch");
assert.equal(node("daily_update_inventory_classify").outputs, 5);
const classRules = node("daily_update_inventory_classify").rules.map((rule) => rule.v ?? rule.t).join(" ");
assert.match(classRules, /bluelink/);
assert.match(classRules, /firmware/);
assert.match(classRules, /home_assistant_core/);
assert.match(classRules, /alexa_media/);
assert.match(classRules, /moni_mobile/);
assert.deepEqual(node("daily_update_inventory_classify").wires, [
  ["daily_update_inventory_kia_out"],
  ["daily_update_inventory_firmware_out"],
  ["daily_update_inventory_core_out"],
  ["daily_update_inventory_hacs_out"],
  ["daily_update_inventory_unknown_out"],
]);
const policyValue = JSON.parse(node("daily_update_inventory_parameters").rules[0].to);
assert.equal(policyValue.scan_interval_minutes, 30);
assert.equal(policyValue.device_firmware_auto, false);
assert.equal(policyValue.manual_candidate_max_age_minutes, 40);
assert.deepEqual(Object.keys(policyValue).sort(), [
  "device_firmware_auto", "manual_candidate_max_age_minutes", "scan_interval_minutes", "version",
]);

const validatePolicy = new Function("msg", "node", "flow", node("daily_update_inventory_validate_policy").func);
const validPolicyMessage = validatePolicy({ update_policy: policyValue }, runtimeNode, flow);
assert.deepEqual(validPolicyMessage.update_policy, policyValue);
for (const boundaryPolicy of [
  { ...policyValue, scan_interval_minutes: 5 },
  { ...policyValue, scan_interval_minutes: 1440 },
  { ...policyValue, manual_candidate_max_age_minutes: 5 },
  { ...policyValue, manual_candidate_max_age_minutes: 120 },
]) {
  assert.deepEqual(validatePolicy({ update_policy: boundaryPolicy }, runtimeNode, flow).update_policy, boundaryPolicy);
}
validatePolicy({ update_policy: policyValue }, runtimeNode, flow);
for (const invalidPolicy of [
  { ...policyValue, scan_interval_minutes: 4 },
  { ...policyValue, scan_interval_minutes: 1441 },
  { ...policyValue, manual_candidate_max_age_minutes: 4 },
  { ...policyValue, manual_candidate_max_age_minutes: 121 },
  { ...policyValue, device_firmware_auto: "false" },
]) {
  const rejected = validatePolicy({ update_policy: invalidPolicy }, runtimeNode, flow);
  assert.deepEqual(rejected.update_policy, policyValue, "invalid visual values must preserve the last valid policy");
}

const normalizeInventory = new Function("msg", "node", "flow", node("daily_update_inventory_normalize").func);
const normalizedInventory = normalizeInventory({
  _ha_updates_test: true,
  update_observed_at: 1000,
  update_policy: policyValue,
  payload: [
    { entity_id: "update.synthetic_firmware", state: "on", attributes: { friendly_name: "SLZB firmware", installed_version: "1", latest_version: "2" } },
    { entity_id: "update.synthetic_hacs", state: "off", attributes: { friendly_name: "HACS Update", installed_version: "2", latest_version: "2" } },
    { entity_id: "update.synthetic_unknown", state: "unavailable", attributes: {} },
    { entity_id: "sensor.not_an_update", state: "on", attributes: {} },
  ],
}, runtimeNode, flow);
assert.equal(normalizedInventory[0].length, 3);
assert.deepEqual(normalizedInventory[0].map((message) => message.payload.state_class), ["pending", "current", "unavailable"]);
assert.equal(normalizedInventory[1].payload.pending, 1);
assert.equal(normalizedInventory[1].payload.unavailable, 1);
assert.equal(normalizedInventory[1]._ha_updates_test, true);

const updateEffects = flows.filter((entry) => entry.z === "daily_host_updates_tab" && entry.type === "api-call-service" && entry.action === "update.install");
assert.deepEqual(updateEffects.map((entry) => entry.id), ["daily_update_firmware_install"]);
assert.deepEqual(node("daily_update_firmware_final_test_gate").wires, [
  ["daily_update_firmware_test_out"],
  ["daily_update_firmware_install"],
]);
assert.equal(node("daily_update_firmware_install").data, '{"entity_id":payload.entity_id}');
assert.match(node("daily_update_firmware_fresh").property, /manual_candidate_max_age_minutes/);
assert.match(node("daily_update_hacs_pending").func, /audit/);
assert.equal(node("daily_update_kia_request_host").addpay, "");
const queueFirmware = new Function("msg", "node", "flow", node("daily_update_firmware_store").func);
queueFirmware({ payload: { entity_id: "update.firmware_b", observed_at: 1, signature: "b:1" } }, runtimeNode, flow);
queueFirmware({ payload: { entity_id: "update.firmware_a", observed_at: 2, signature: "a:1" } }, runtimeNode, flow);
queueFirmware({ payload: { entity_id: "update.firmware_b", observed_at: 3, signature: "b:1" } }, runtimeNode, flow);
const takeFirmware = new Function("msg", "node", "flow", node("daily_update_firmware_take_candidate").func);
assert.equal(takeFirmware({}, runtimeNode, flow).payload.entity_id, "update.firmware_a");
assert.equal(takeFirmware({}, runtimeNode, flow).payload.observed_at, 3);
assert.equal(takeFirmware({}, runtimeNode, flow).payload, null);

const parseKia = new Function("msg", "node", "flow", node("daily_update_kia_parse_result").func);
const kiaTestConflict = parseKia(
  { _kia_update_test: true, payload: "kia-uvo-update status=conflict request_id=test installed_version=3.10.1 latest_version=v3.11.0 patch_state=conflict conflicts=1 checked_at=synthetic" },
  runtimeNode,
  flow,
);
assert.equal(kiaTestConflict[0].payload.status, "conflict");
assert.equal(kiaTestConflict[0].payload.conflicts, 1);
assert.equal(kiaTestConflict[1], null, "synthetic conflicts must not reach Codex");
assert.equal(errors.length, 1, "synthetic Kia conflicts must not alert production observers");
const kiaProductionConflict = parseKia(
  { payload: "kia-uvo-update status=conflict request_id=prod-conflict installed_version=3.10.1 latest_version=v3.11.0 patch_state=conflict conflicts=1 checked_at=synthetic" },
  runtimeNode,
  flow,
);
assert.equal(kiaProductionConflict[0], null);
assert.equal(kiaProductionConflict[1].payload, "v3.11.0");
assert.equal(kiaProductionConflict[1].kia_uvo_update.status, "conflict");
assert.deepEqual(parseKia(
  { payload: "kia-uvo-update status=failed request_id=prod-kia" },
  runtimeNode,
  flow,
), [null, null]);
assert.match(errors.at(-1), /kia_uvo_update_check_failed/);

const parseKiaCodexMerge = new Function("msg", "node", "flow", node("daily_update_kia_codex_parse_result").func);
const kiaCodexTestFailure = parseKiaCodexMerge(
  { _kia_codex_merge_test: true, payload: "kia-uvo-codex-merge state=failed target=v3.12.0 updated_at=synthetic" },
  runtimeNode,
  flow,
);
assert.equal(kiaCodexTestFailure.payload.state, "failed");
assert.equal(kiaCodexTestFailure.payload.target, "v3.12.0");
assert.equal(kiaCodexTestFailure.payload.updated_at, "synthetic");
assert.match(errors.at(-1), /kia_uvo_update_check_failed/, "synthetic Codex failures must not alert production observers");
assert.equal(parseKiaCodexMerge(
  { payload: "kia-uvo-codex-merge state=failed target=v3.12.0 updated_at=synthetic" },
  runtimeNode,
  flow,
), null);
assert.match(errors.at(-1), /kia_uvo_codex_merge_failed target=v3.12.0/);
assert.equal(errorMessages.at(-1).payload, "kia-uvo-codex-merge state=failed target=v3.12.0 updated_at=synthetic");
const errorsAfterCodexFailure = errors.length;
assert.equal(parseKiaCodexMerge(
  { payload: "kia-uvo-codex-merge state=failed target=v3.12.0 updated_at=synthetic" },
  runtimeNode,
  flow,
), null);
assert.equal(errors.length, errorsAfterCodexFailure, "duplicate Codex worker failures must be deduplicated");

const parseKiaPromotion = new Function("msg", "node", "flow", node("daily_update_kia_promotion_parse_result").func);
const kiaPromotionTestFailure = parseKiaPromotion(
  { _kia_promotion_test: true, payload: "kia-uvo-promotion state=failed target=v3.12.0 updated_at=synthetic" },
  runtimeNode,
  flow,
);
assert.equal(kiaPromotionTestFailure.payload.state, "failed");
assert.equal(kiaPromotionTestFailure.payload.target, "v3.12.0");
const errorsBeforePromotionFailure = errors.length;
assert.equal(parseKiaPromotion(
  { payload: "kia-uvo-promotion state=failed target=v3.12.0 updated_at=synthetic" },
  runtimeNode,
  flow,
), null);
assert.match(errors.at(-1), /kia_uvo_promotion_failed state=failed target=v3.12.0/);
assert.equal(parseKiaPromotion(
  { payload: "kia-uvo-promotion state=failed target=v3.12.0 updated_at=synthetic" },
  runtimeNode,
  flow,
), null);
assert.equal(errors.length, errorsBeforePromotionFailure + 1, "duplicate promotion failures must be deduplicated");

const compose = fs.readFileSync(path.resolve(here, "..", "..", "docker-compose.yml"), "utf8");
assert.match(compose, /\.\/homeassistant\/\.daily-update-trigger:\/run\/daily-update-trigger/);
assert.match(compose, /request-host-daily-update\.sh:\/opt\/request-host-daily-update\.sh:ro/);
assert.match(compose, /read-host-daily-update-result\.sh:\/opt\/read-host-daily-update-result\.sh:ro/);
assert.match(compose, /request-host-update-stage\.sh:\/opt\/request-host-update-stage\.sh:ro/);
assert.match(compose, /read-host-update-stage-result\.sh:\/opt\/read-host-update-stage-result\.sh:ro/);
assert.match(compose, /request-host-kia-uvo-update-check\.sh:\/opt\/request-host-kia-uvo-update-check\.sh:ro/);
assert.match(compose, /read-host-kia-uvo-update-result\.sh:\/opt\/read-host-kia-uvo-update-result\.sh:ro/);
assert.match(compose, /request-kia-uvo-codex-merge\.sh:\/opt\/request-kia-uvo-codex-merge\.sh:ro/);
assert.match(compose, /read-kia-uvo-codex-merge-result\.sh:\/opt\/read-kia-uvo-codex-merge-result\.sh:ro/);
assert.match(compose, /read-kia-uvo-promotion-result\.sh:\/opt\/read-kia-uvo-promotion-result\.sh:ro/);
assert.match(compose, /\.\/\.local-state\/kia-uvo-merge-trigger:\/run\/kia-uvo-merge-trigger/);
assert.match(compose, /kia-uvo-codex-merge:/);
assert.match(compose, /KIA_UVO_MERGE_PUSH=\$\{KIA_UVO_MERGE_PUSH:-true\}/);

console.log("Daily host update flow contracts are valid");
