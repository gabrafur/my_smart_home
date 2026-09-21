#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

const TAB = "daily_host_updates_tab";
const SERVER = "4126427d5e161a03";
const owned = (id) => id === TAB || id.startsWith("daily_update_");
const functionNode = (id, group, name, func, outputs, x, y, wires) => ({
  id, type: "function", z: TAB, g: group, name, func, outputs,
  timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires,
});

const prepareRequest = `const TEST_MODE = msg._daily_update_test === true || msg.payload?.test_mode === true;
const event = msg.payload?.event ?? "git_backup_completed";
if (!TEST_MODE && (event !== "git_backup_completed" || msg.payload?.status !== "success")) {
    node.warn("daily_update_ignored_without_successful_backup");
    return null;
}
msg._daily_update_test = TEST_MODE;
msg.payload = {
    version: 1,
    event: "daily_update_requested",
    source: TEST_MODE ? "manual_test" : "git_backup",
    backup_finished_at: msg.payload?.finished_at ?? null,
    test_mode: TEST_MODE
};
node.status({ fill: TEST_MODE ? "blue" : "green", shape: "dot", text: TEST_MODE ? "TESTE preparado" : "backup concluído; solicitando" });
return msg;`;

const recordRequest = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\\bstatus=(accepted|coalesced)\\b/)?.[1];
if (!status) {
    node.error("daily_update_request_unrecognized", msg);
    node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
    return null;
}
node.status({ fill: status === "accepted" ? "green" : "yellow", shape: "dot", text: status === "accepted" ? "solicitação aceita" : "solicitação coalescida" });
return null;`;

const recordExecError = `const detail = String(msg.payload ?? "indisponível").replace(/[\\r\\n]+/g, " ").slice(0, 240);
node.status({ fill: "red", shape: "ring", text: "ponte indisponível" });
node.error("daily_update_bridge_unavailable detail=" + detail, msg);
return null;`;

const recordCompletion = `const code = Number(msg.payload?.code ?? msg.payload ?? -1);
if (code !== 0) {
    node.status({ fill: "red", shape: "ring", text: "ponte código " + String(code) });
    if (msg._daily_update_test !== true && msg.payload?.test_mode !== true) node.error("daily_update_bridge_exit_failed code=" + code, { _msgid: msg._msgid });
}
return null;`;

const normalizeRepositoryDependencyAudit = `const TEST_MODE = msg._repository_dependency_test === true;
let report = msg.payload;
try {
    if (typeof report === "string") report = JSON.parse(report);
} catch {
    report = null;
}
if (!report || report.version !== 1 || report.status !== "ok" || !Array.isArray(report.candidates)) {
    if (!TEST_MODE) node.error("repository_dependency_audit_unavailable", msg);
    return [null, null];
}
const candidates = report.candidates.map((candidate) => ({
    payload: candidate,
    dependency_policy: msg.dependency_policy,
    _repository_dependency_test: TEST_MODE
}));
const summary = {
    payload: { version: 1, status: "scanned", candidate_count: candidates.length, test_mode: TEST_MODE },
    _repository_dependency_test: TEST_MODE
};
node.status({ fill: candidates.length ? "yellow" : "green", shape: "dot", text: candidates.length + " vulnerável(is)" });
return [candidates.length ? candidates : null, summary];`;

const prepareRepositoryDependencyRequest = `const candidate = msg.payload;
if (!candidate || typeof candidate.package !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(candidate.package)) {
    if (!msg._repository_dependency_test) node.error("repository_dependency_candidate_invalid", msg);
    return null;
}
msg.repository_dependency = candidate;
msg.payload = candidate.package;
node.status({ fill: msg._repository_dependency_test ? "blue" : "green", shape: "dot", text: candidate.package + " elegível" });
return msg;`;

const recordRepositoryDependencyRequest = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\\bstatus=(accepted|coalesced|deferred)\\b/)?.[1];
if (!status) {
    node.error("repository_dependency_request_unrecognized", msg);
    return null;
}
node.status({ fill: status === "accepted" ? "green" : "yellow", shape: "dot", text: status });
return null;`;

const parseRepositoryDependencyResult = `const TEST_MODE = msg._repository_dependency_test === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 700);
if (!text) return [null, null, null];
const statusMatches = [...text.matchAll(/\\bstatus=(running|success|current|failed|deferred)\\b/g)];
const status = statusMatches.at(-1)?.[1];
const packageMatches = [...text.matchAll(/\\bpackage=([a-z0-9._-]+)\\b/g)];
const packageName = packageMatches.at(-1)?.[1] ?? "unknown";
const requestId = text.match(/\\brequest_id=([^ ]+)\\b/)?.[1] ?? "unknown";
if (!status) {
    if (!TEST_MODE) node.error("repository_dependency_result_unrecognized", msg);
    return [null, null, null];
}
const result = {
    version: 1, status, package: packageName, request_id: requestId,
    from: text.match(/\\bfrom=([^ ]+)\\b/)?.[1] ?? null,
    to: text.match(/\\bto=([^ ]+)\\b/)?.[1] ?? null,
    test_mode: TEST_MODE, observed_at: Date.now()
};
const signature = [packageName, requestId, status, result.to].join(":");
const key = TEST_MODE ? "repository_dependency_last_result_v1__test" : "repository_dependency_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return [null, null, null];
result.signature = signature;
if (TEST_MODE) flow.set(key, result); else flow.set(key, result, "persistent");
msg.payload = result;
node.status({ fill: status === "failed" ? "red" : status === "success" || status === "current" ? "green" : "yellow", shape: status === "failed" ? "ring" : "dot", text: packageName + ": " + status });
if (TEST_MODE) return [msg, null, null];
if (status === "failed") {
    node.error("repository_dependency_update_failed package=" + packageName + " request_id=" + requestId, msg);
    return [null, null, null];
}
if (status === "success") return [null, msg, null];
if (status === "deferred") return [null, null, msg];
return [null, null, null];`;

const recordRepositoryDependencyBlocked = `const candidate = msg.payload ?? {};
node.status({ fill: "yellow", shape: "ring", text: String(candidate.package ?? "candidato") + " bloqueado pela política" });
if (msg._repository_dependency_test) {
    msg.payload = { version: 1, status: "policy_blocked", package: candidate.package ?? null, test_mode: true };
    return msg;
}
node.warn("repository_dependency_candidate_blocked package=" + String(candidate.package ?? "unknown"));
return null;`;

const prepareHostStage = (stage) => `const TEST_MODE = msg._daily_update_test === true || msg.payload?.test_mode === true;
msg._daily_update_test = TEST_MODE;
msg.payload = {
    version: 1,
    event: "host_update_stage_requested",
    stage: "${stage}",
    source: TEST_MODE ? "manual_test" : (msg.payload?.stage ?? "previous_stage"),
    test_mode: TEST_MODE,
    requested_at: new Date().toISOString()
};
node.status({ fill: TEST_MODE ? "blue" : "green", shape: "dot", text: TEST_MODE ? "TESTE preparado" : "${stage} solicitado" });
return msg;`;

const parseHostStageResult = (expectedStage, label, hasNext) => `const TEST_MODE = msg._daily_update_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 700);
if (!text) return [null, null];
const status = text.match(/\\bstatus=(running|success|failed|deferred|unavailable)\\b/)?.[1];
const stage = text.match(/\\bstage=([a-z-]+)\\b/)?.[1] ?? null;
const requestId = text.match(/\\brequest_id=([^ ]+)\\b/)?.[1] ?? "unknown";
const stageExit = Number(text.match(/\\bstage_exit=(\\d+)\\b/)?.[1] ?? NaN);
const failureStage = text.match(/\\bfailure_stage=([A-Za-z0-9_.-]+)\\b/)?.[1] ?? null;
if (!status || stage !== "${expectedStage}") {
    if (!TEST_MODE) node.error("host_update_stage_result_unrecognized expected=${expectedStage}", msg);
    return [null, null];
}
const signature = [stage, requestId, status].join(":");
const key = TEST_MODE ? "host_update_${expectedStage}_last_result_v1__test" : "host_update_${expectedStage}_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return [null, null];
const result = {
    version: 1, signature, stage, request_id: requestId, status,
    stage_exit: Number.isFinite(stageExit) ? stageExit : null,
    failure_stage: failureStage,
    test_mode: TEST_MODE,
    observed_at: Date.now()
};
if (TEST_MODE) flow.set(key, result);
else flow.set(key, result, "persistent");
const failed = ["failed", "unavailable"].includes(status);
node.status({
    fill: failed ? "red" : status === "success" ? "green" : "yellow",
    shape: failed ? "ring" : "dot",
    text: status === "success" ? "${label} concluído" : status
});
msg.payload = result;
if (TEST_MODE) return [msg, null];
if (failed) {
    node.error("host_update_stage_failed stage=${expectedStage} request_id=" + requestId + " failure_stage=" + String(failureStage) + " stage_exit=" + String(result.stage_exit), msg);
    return [null, null];
}
if (status === "success" && ${hasNext ? "true" : "false"}) return [null, msg];
return [null, null];`;

const prepareKiaUpdateCheck = `const TEST_MODE = msg._kia_update_test === true || msg.payload?.test_mode === true;
msg._kia_update_test = TEST_MODE;
const rawTarget = String(msg.payload?.latest_version ?? msg.payload?.target ?? (TEST_MODE ? "v3.13.0" : "")).trim();
const target = rawTarget.startsWith("v") ? rawTarget : "v" + rawTarget;
if (!/^v\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(target)) {
    if (!TEST_MODE) node.error("kia_uvo_update_target_invalid", msg);
    return null;
}
const mode = msg.kia_update_mode === "install" ? "install" : "audit";
msg.kia_uvo_target = target;
msg.payload = mode + ":" + target;
node.status({
    fill: TEST_MODE ? "blue" : mode === "install" ? "green" : "yellow",
    shape: "dot",
    text: TEST_MODE ? "TESTE preparado" : mode === "install" ? "instalação segura solicitada" : "auditoria solicitada"
});
return msg;`;

const recordKiaUpdateRequest = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\\bstatus=(accepted|coalesced)\\b/)?.[1];
if (!status) {
    node.error("kia_uvo_update_request_unrecognized", msg);
    node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
    return null;
}
node.status({ fill: status === "accepted" ? "green" : "yellow", shape: "dot", text: status === "accepted" ? "análise aceita" : "análise já pendente" });
return null;`;

const prepareAlexaMediaRequest = `const TEST_MODE = msg._ha_updates_test === true || msg.payload?.test_mode === true;
const entityId = String(msg.payload?.entity_id ?? "");
const rawTarget = String(msg.payload?.latest_version ?? "").trim();
const target = rawTarget.startsWith("v") ? rawTarget : "v" + rawTarget;
if ((!TEST_MODE && entityId !== "update.alexa_media_player_update") ||
    !/^v\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(target)) {
    if (!TEST_MODE) node.error("alexa_media_update_candidate_invalid", msg);
    return null;
}
msg.alexa_media_update = { entity_id: entityId, target, test_mode: TEST_MODE };
msg.payload = target;
node.status({ fill: TEST_MODE ? "blue" : "green", shape: "dot", text: TEST_MODE ? "TESTE preparado" : "auditoria + instalação: " + target });
return msg;`;

const recordAlexaMediaRequest = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\\bstatus=(accepted|coalesced)\\b/)?.[1];
const target = text.match(/\\btarget=(v[0-9][A-Za-z0-9.+-]*)\\b/)?.[1] ?? "unknown";
if (!status) {
    node.error("alexa_media_update_request_unrecognized", msg);
    node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
    return null;
}
node.status({ fill: status === "accepted" ? "green" : "yellow", shape: "dot", text: status + ": " + target });
return null;`;

const parseAlexaMediaResult = `const TEST_MODE = msg._alexa_media_update_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 700);
if (!text) return [null, null];
const status = text.match(/\\bstatus=(running|success|current|failed|deferred|rollback|conflict)\\b/)?.[1];
const target = text.match(/\\btarget=(v[0-9][A-Za-z0-9.+-]*)\\b/)?.[1] ?? "unknown";
const requestId = text.match(/\\brequest_id=([^ ]+)\\b/)?.[1] ?? "unknown";
if (!status) {
    if (!TEST_MODE) node.error("alexa_media_update_result_unrecognized", msg);
    return [null, null];
}
const result = { version: 1, status, target, request_id: requestId, test_mode: TEST_MODE, observed_at: Date.now() };
const signature = [status, target, requestId].join(":");
const key = TEST_MODE ? "alexa_media_update_last_result_v1__test" : "alexa_media_update_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return [null, null];
result.signature = signature;
if (TEST_MODE) flow.set(key, result); else flow.set(key, result, "persistent");
const failed = ["failed", "rollback", "conflict"].includes(status);
node.status({
    fill: failed ? "red" : ["success", "current"].includes(status) ? "green" : "yellow",
    shape: failed ? "ring" : "dot",
    text: target + ": " + status
});
msg.payload = result;
if (TEST_MODE) return [msg, null];
if (failed) {
    node.error("alexa_media_update_failed status=" + status + " target=" + target + " request_id=" + requestId, msg);
    return [null, null];
}
if (["success", "current"].includes(status)) return [null, msg];
return [null, null];`;

const recordKiaCodexMergeRequest = `const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\\bstatus=(accepted|coalesced)\\b/)?.[1];
const target = text.match(/\\btarget=(v?[A-Za-z0-9.+-]+)\\b/)?.[1] ?? "unknown";
if (!status) {
    node.error("kia_uvo_codex_merge_request_unrecognized", msg);
    node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
    return null;
}
node.status({ fill: status === "accepted" ? "green" : "yellow", shape: "dot", text: status === "accepted" ? "Codex solicitado: " + target : "merge já pendente/concluído" });
node.log("kia_uvo_codex_merge_request status=" + status + " target=" + target);
return null;`;

const parseKiaCodexMergeResult = `const TEST_MODE = msg._kia_codex_merge_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
if (!text) return null;
const state = text.match(/\\bstate=(waiting|running|success|failed|unknown)\\b/)?.[1];
const target = text.match(/\\btarget=(v?[A-Za-z0-9.+-]+)\\b/)?.[1] ?? "unknown";
const updatedAt = text.match(/\\bupdated_at=([^ ]+)\\b/)?.[1] ?? "unknown";
if (!state || state === "unknown") {
    if (!TEST_MODE) node.error("kia_uvo_codex_merge_result_unrecognized", msg);
    return null;
}
const result = {
    version: 1,
    state,
    target,
    updated_at: updatedAt,
    test_mode: TEST_MODE,
    observed_at: Date.now()
};
const signature = [result.state, result.target, result.updated_at].join(":");
const key = TEST_MODE ? "kia_uvo_codex_merge_last_result_v1__test" : "kia_uvo_codex_merge_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return null;
result.signature = signature;
if (TEST_MODE) flow.set(key, result);
else flow.set(key, result, "persistent");
node.status({
    fill: state === "failed" ? "red" : state === "success" ? "green" : "blue",
    shape: state === "failed" ? "ring" : "dot",
    text: state === "success" ? "candidata pronta: " + target : state + ": " + target
});
if (TEST_MODE) {
    msg.payload = result;
    return msg;
}
if (state === "failed") {
    node.error("kia_uvo_codex_merge_failed target=" + target + " updated_at=" + updatedAt, msg);
}
return null;`;

const parseKiaPromotionResult = `const TEST_MODE = msg._kia_promotion_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 400);
if (!text) return null;
const state = text.match(/\\bstate=(deferred|applying|runtime_applied|applied_pending_git|main_published|completed|failed|unknown)\\b/)?.[1];
const target = text.match(/\\btarget=(v?[A-Za-z0-9.+-]+)\\b/)?.[1] ?? "unknown";
const updatedAt = text.match(/\\bupdated_at=([^ ]+)\\b/)?.[1] ?? "unknown";
if (!state || state === "unknown") {
    if (!TEST_MODE) node.error("kia_uvo_promotion_result_unrecognized", msg);
    return null;
}
const result = {
    version: 1,
    state,
    target,
    updated_at: updatedAt,
    test_mode: TEST_MODE,
    observed_at: Date.now()
};
const signature = [result.state, result.target, result.updated_at].join(":");
const key = TEST_MODE ? "kia_uvo_promotion_last_result_v1__test" : "kia_uvo_promotion_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return null;
result.signature = signature;
if (TEST_MODE) flow.set(key, result);
else flow.set(key, result, "persistent");
const failed = ["failed", "deferred"].includes(state);
const completed = state === "completed";
node.status({
    fill: failed ? "red" : completed ? "green" : "blue",
    shape: failed ? "ring" : "dot",
    text: completed ? "runtime e main confirmados: " + target
        : state === "applying" ? "validando runtime: " + target
        : state + ": " + target
});
if (TEST_MODE) {
    msg.payload = result;
    return msg;
}
if (failed) {
    node.error("kia_uvo_promotion_failed state=" + state + " target=" + target + " updated_at=" + updatedAt, msg);
}
return null;`;

const parseKiaUpdateResult = `const TEST_MODE = msg._kia_update_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\\r\\n]+/g, " ").trim().slice(0, 700);
if (!text) return null;
const status = text.match(/\\bstatus=(running|compatible|conflict|applied|rollback|failed|deferred|unavailable|unknown)\\b/)?.[1];
if (!status) {
    if (!TEST_MODE) node.error("kia_uvo_update_result_unrecognized", msg);
    return null;
}
const result = {
    version: 1,
    status,
    request_id: text.match(/\\brequest_id=([^ ]+)\\b/)?.[1] ?? "unknown",
    mode: text.match(/\\bmode=(audit|install)\\b/)?.[1] ?? "audit",
    installed_version: text.match(/\\binstalled_version=([^ ]+)\\b/)?.[1] ?? null,
    latest_version: text.match(/\\blatest_version=([^ ]+)\\b/)?.[1] ?? null,
    patch_state: text.match(/\\bpatch_state=([^ ]+)\\b/)?.[1] ?? null,
    conflicts: Number(text.match(/\\bconflicts=(\\d+)\\b/)?.[1] ?? 0),
    checked_at: text.match(/\\bchecked_at=([^ ]+)\\b/)?.[1] ?? null,
    test_mode: TEST_MODE,
    observed_at: Date.now()
};
const signature = [result.request_id, result.status, result.latest_version, result.checked_at].join(":");
const key = TEST_MODE ? "kia_uvo_update_last_result_v1__test" : "kia_uvo_update_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (!TEST_MODE && previous?.signature === signature) return null;
result.signature = signature;
if (TEST_MODE) flow.set(key, result);
else flow.set(key, result, "persistent");
const failed = ["failed", "unavailable", "rollback"].includes(status);
const compatible = ["compatible", "applied"].includes(status);
node.status({
    fill: failed ? "red" : compatible ? "green" : status === "conflict" ? "yellow" : "blue",
    shape: failed || status === "conflict" ? "ring" : "dot",
    text: status === "conflict"
        ? "v" + String(result.latest_version ?? "?") + ": conflito; preservado"
        : status
});
if (TEST_MODE) {
    msg.payload = result;
    return [msg, null];
}
if (failed) node.error("kia_uvo_update_check_failed status=" + status + " request_id=" + result.request_id, msg);
else if (["compatible", "conflict"].includes(status) && result.mode === "install") {
    if (status === "conflict") node.warn("kia_uvo_update_requires_codex_merge latest=" + String(result.latest_version));
    if (!result.latest_version) {
        node.error("kia_uvo_codex_merge_missing_target", msg);
        return [null, null];
    }
    msg.payload = result.latest_version;
    msg.kia_uvo_update = result;
    return [null, msg];
}
return [null, null];`;

const parseResult = parseHostStageResult("dietpi", "DietPi", true);

const resetTest = `flow.set("daily_update_last_result_v1__test", undefined);
flow.set("host_update_dietpi_last_result_v1__test", undefined);
flow.set("host_update_home-assistant-core_last_result_v1__test", undefined);
flow.set("host_update_containers_last_result_v1__test", undefined);
flow.set("host_update_codex-cli_last_result_v1__test", undefined);
flow.set("repository_dependency_last_result_v1__test", undefined);
flow.set("daily_update_inventory_last_v1__test", undefined);
flow.set("kia_uvo_update_last_result_v1__test", undefined);
flow.set("kia_uvo_codex_merge_last_result_v1__test", undefined);
flow.set("kia_uvo_promotion_last_result_v1__test", undefined);
flow.set("alexa_media_update_last_result_v1__test", undefined);
flow.set("daily_update_last_dry_run_v1", {
    version: 1, reset: true, simulated: true, dispatched: false,
    completed_at: Date.now()
});
node.status({ fill: "grey", shape: "ring", text: "estado de teste resetado" });
return null;`;

const dryRunTerminal = `const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    host_request_sent: false,
    apt_commands_sent: false,
    home_assistant_core_update_sent: false,
    docker_update_sent: false,
    codex_cli_update_sent: false,
    repository_dependency_update_sent: false,
    npm_install_sent: false,
    hacs_update_install_sent: false,
    alexa_media_update_requested: false,
    device_firmware_install_sent: false,
    kia_uvo_update_check_sent: false,
    kia_uvo_codex_merge_requested: false,
    codex_worker_started: false,
    git_push_sent: false,
    status: msg.payload?.status ?? msg.payload?.event ?? "request_prepared",
    completed_at: Date.now()
};
flow.set("daily_update_last_dry_run_v1", result);
node.status({ fill: "blue", shape: "dot", text: "TESTE: " + result.status + "; host bloqueado" });
return null;`;

const validateUpdatePolicy = `const policy = msg.update_policy;
const valid = policy && policy.version === 1 &&
    Number.isInteger(policy.scan_interval_minutes) && policy.scan_interval_minutes >= 5 && policy.scan_interval_minutes <= 1440 &&
    typeof policy.device_firmware_auto === "boolean" &&
    typeof policy.versioned_hacs_auto_apply === "boolean" &&
    typeof policy.kia_uvo_auto_apply === "boolean" &&
    Number.isInteger(policy.manual_candidate_max_age_minutes) && policy.manual_candidate_max_age_minutes >= 5 && policy.manual_candidate_max_age_minutes <= 120;
const key = "daily_update_visual_policy_v1";
if (!valid) {
    const previous = flow.get(key, "persistent");
    if (!previous) {
        node.error("daily_update_visual_policy_invalid_without_previous", msg);
        return null;
    }
    msg.update_policy = previous;
    node.status({ fill: "red", shape: "ring", text: "inválido; último válido preservado" });
    return msg;
}
flow.set(key, policy, "persistent");
node.status({ fill: "green", shape: "dot", text: "política visual válida" });
return msg;`;

const normalizeUpdateInventory = `const TEST_MODE = msg._ha_updates_test === true || msg.payload?.test_mode === true;
const states = Array.isArray(msg.ha_update_states) ? msg.ha_update_states : Array.isArray(msg.payload) ? msg.payload : null;
if (!states) {
    if (!TEST_MODE) node.error("home_assistant_update_inventory_invalid", msg);
    return [null, null];
}
const observedAt = Number(msg.update_observed_at ?? Date.now());
const updates = states
    .filter((entity) => typeof entity?.entity_id === "string" && entity.entity_id.startsWith("update."))
    .map((entity) => {
        const state = String(entity.state ?? "unknown").toLowerCase();
        const friendlyName = String(entity.attributes?.friendly_name ?? entity.entity_id).slice(0, 160);
        const item = {
            version: 1,
            entity_id: entity.entity_id,
            friendly_name: friendlyName,
            state,
            state_class: state === "on" ? "pending" : state === "off" ? "current" : "unavailable",
            installed_version: entity.attributes?.installed_version ?? null,
            latest_version: entity.attributes?.latest_version ?? null,
            search_key: (entity.entity_id + " " + friendlyName).toLowerCase(),
            observed_at: observedAt,
            test_mode: TEST_MODE
        };
        item.signature = [item.entity_id, item.state_class, item.installed_version, item.latest_version].join(":");
        return item;
    });
const messages = updates.map((payload) => ({
    payload,
    topic: payload.entity_id,
    update_policy: msg.update_policy,
    _update_apply_authorized: msg._update_apply_authorized === true,
    _ha_updates_test: TEST_MODE,
    _kia_update_test: TEST_MODE
}));
const summary = {
    version: 1,
    total: updates.length,
    pending: updates.filter((item) => item.state_class === "pending").length,
    unavailable: updates.filter((item) => item.state_class === "unavailable").length,
    observed_at: observedAt,
    test_mode: TEST_MODE,
    apply_authorized: msg._update_apply_authorized === true
};
return [messages.length ? messages : null, { payload: summary, _ha_updates_test: TEST_MODE }];`;

const recordUpdateInventory = `const summary = msg.payload;
const key = summary.test_mode ? "daily_update_inventory_last_v1__test" : "daily_update_inventory_last_v1";
if (summary.test_mode) flow.set(key, summary);
else flow.set(key, summary, "persistent");
node.status({
    fill: summary.unavailable > 0 ? "yellow" : summary.pending > 0 ? "blue" : "green",
    shape: summary.unavailable > 0 ? "ring" : "dot",
    text: summary.pending + " pendente(s); " + summary.unavailable + " indisponível(is)"
});
return summary.test_mode ? msg : null;`;

const recordPendingUpdate = (kind, label) => `const item = msg.payload;
node.status({ fill: "yellow", shape: "ring", text: "${label}: " + String(item.latest_version ?? "versão desconhecida") });
node.warn("update_pending kind=${kind} entity=" + item.entity_id + " latest=" + String(item.latest_version ?? "unknown"));
return null;`;

const queueFirmwareCandidate = `const key = "daily_update_firmware_candidates_v1";
const queue = flow.get(key, "persistent") ?? [];
const candidate = msg.payload;
const next = queue.filter((item) => item.entity_id !== candidate.entity_id);
next.push(candidate);
next.sort((left, right) => String(left.entity_id).localeCompare(String(right.entity_id)));
flow.set(key, next, "persistent");
msg.firmware_queue_count = next.length;
node.status({ fill: "yellow", shape: "dot", text: next.length + " candidato(s) manual(is)" });
return msg;`;

const takeFirmwareCandidate = `const key = "daily_update_firmware_candidates_v1";
const queue = flow.get(key, "persistent") ?? [];
const candidate = queue.shift() ?? null;
flow.set(key, queue, "persistent");
msg.payload = candidate;
msg.update_policy = flow.get("daily_update_visual_policy_v1", "persistent");
node.status({ fill: candidate ? "blue" : "yellow", shape: candidate ? "dot" : "ring", text: candidate ? "candidato consumido; restam " + queue.length : "fila vazia" });
return msg;`;

const productionGroup = "daily_update_production_group";
const resultGroup = "daily_update_result_group";
const coreGroup = "daily_update_core_group";
const containersGroup = "daily_update_containers_group";
const codexCliGroup = "daily_update_codex_cli_group";
const dependencyGroup = "daily_update_repository_dependency_group";
const dependencyTestGroup = "daily_update_repository_dependency_test_group";
const testGroup = "daily_update_test_group";
const inventoryGroup = "daily_update_inventory_group";
const hacsGroup = "daily_update_hacs_group";
const alexaGroup = "daily_update_alexa_media_group";
const firmwareGroup = "daily_update_firmware_group";
const unknownGroup = "daily_update_unknown_group";
const kiaUpdateGroup = "daily_update_kia_group";
const kiaCodexGroup = "daily_update_kia_codex_group";
const nodes = [
  {
    id: TAB, type: "tab", label: "atualizacoes_diarias", disabled: false,
    info: "Orquestrador canônico de updates. Depois do backup Git, executa serialmente DietPi, Home Assistant Core, demais containers e Codex CLI antes das dependências do repositório. Também inventaria toda entidade update.*; às 03:00, uma autorização efêmera permite atualizar Alexa Media e Kia UVO somente após auditoria de upstream, staging, backup, rollback e validação. Demais HACS versionados, firmware físico e fontes desconhecidas mantêm políticas visuais próprias. O Node-RED não recebe sudo, npm, checkout, credenciais nem socket Docker.",
    env: [],
  },
  {
    id: productionGroup, type: "group", z: TAB,
    name: "1. SUBFLUXO DietPi: atualizar host depois do backup",
    style: { label: true, color: "#4d9a6a" },
    nodes: [
      "daily_update_architecture", "daily_update_after_backup_in", "daily_update_test_request_in",
      "daily_update_prepare_request", "daily_update_route_test", "daily_update_request_host",
      "daily_update_request_ack", "daily_update_request_error", "daily_update_request_complete",
      "daily_update_request_test_out",
    ],
    x: 104, y: 39, w: 1212, h: 262,
  },
  {
    id: "daily_update_architecture", type: "comment", z: TAB, g: productionGroup,
    name: "DietPi roda somente após backup; sucesso libera o subfluxo Home Assistant Core",
    info: "A ponte coalesce solicitações. O helper root-owned limita sudo ao apt-get update/upgrade e ao dietpi-update. Não há reboot automático.",
    x: 650, y: 80, wires: [],
  },
  {
    id: "daily_update_after_backup_in", type: "link in", z: TAB, g: productionGroup,
    name: "Receber backup diário concluído", links: ["git_backup_daily_update_out"],
    x: 145, y: 160, wires: [["daily_update_prepare_request"]],
  },
  {
    id: "daily_update_test_request_in", type: "link in", z: TAB, g: productionGroup,
    name: "Receber solicitação TESTE", links: ["daily_update_test_request_out"],
    x: 145, y: 220, wires: [["daily_update_prepare_request"]],
  },
  functionNode("daily_update_prepare_request", productionGroup, "Validar backup e preparar ciclo", prepareRequest, 1, 410, 190, [["daily_update_route_test"]]),
  {
    id: "daily_update_route_test", type: "switch", z: TAB, g: productionGroup,
    name: "Produção ou TESTE?", property: "_daily_update_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 660, y: 190, wires: [["daily_update_request_test_out"], ["daily_update_request_host"]],
  },
  {
    id: "daily_update_request_host", type: "exec", z: TAB, g: productionGroup,
    command: "/opt/request-host-update-stage.sh dietpi", addpay: "", append: "", useSpawn: "false",
    timer: "30", winHide: false, oldrc: false, name: "Solicitar ciclo ao host",
    x: 920, y: 220,
    wires: [["daily_update_request_ack"], ["daily_update_request_error"], ["daily_update_request_complete"]],
  },
  functionNode("daily_update_request_ack", productionGroup, "Registrar solicitação", recordRequest, 0, 1180, 140, []),
  functionNode("daily_update_request_error", productionGroup, "Falha segura da ponte", recordExecError, 0, 1180, 220, []),
  functionNode("daily_update_request_complete", productionGroup, "Registrar código da ponte", recordCompletion, 0, 1180, 300, []),
  {
    id: "daily_update_request_test_out", type: "link out", z: TAB, g: productionGroup,
    name: "Solicitação TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 920, y: 140, wires: [],
  },
  {
    id: resultGroup, type: "group", z: TAB,
    name: "2. SUBFLUXO DietPi: observar resultado e liberar Core",
    style: { label: true, color: "#3f7cb5" },
    nodes: [
      "daily_update_result_startup", "daily_update_result_poll", "daily_update_read_result",
      "daily_update_read_error", "daily_update_read_complete", "daily_update_test_result_in",
      "daily_update_parse_result", "daily_update_result_test_out", "daily_update_core_request_out",
    ],
    x: 54, y: 399, w: 1072, h: 192,
  },
  {
    id: "daily_update_result_startup", type: "inject", z: TAB, g: resultGroup,
    name: "Ler resultado ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "15", topic: "", payload: "", payloadType: "date",
    x: 200, y: 470, wires: [["daily_update_read_result"]],
  },
  {
    id: "daily_update_result_poll", type: "inject", z: TAB, g: resultGroup,
    name: "A cada 5 min", props: [{ p: "payload" }], repeat: "300", crontab: "",
    once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date",
    x: 200, y: 530, wires: [["daily_update_read_result"]],
  },
  {
    id: "daily_update_read_result", type: "exec", z: TAB, g: resultGroup,
    command: "/opt/read-host-update-stage-result.sh dietpi", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado seguro",
    x: 480, y: 500,
    wires: [["daily_update_parse_result"], ["daily_update_read_error"], ["daily_update_read_complete"]],
  },
  functionNode("daily_update_read_error", resultGroup, "Falha ao ler resultado", recordExecError, 0, 800, 520, []),
  functionNode("daily_update_read_complete", resultGroup, "Código da leitura", recordCompletion, 0, 800, 600, []),
  {
    id: "daily_update_test_result_in", type: "link in", z: TAB, g: resultGroup,
    name: "Receber resultado TESTE", links: ["daily_update_test_result_out"],
    x: 480, y: 400, wires: [["daily_update_parse_result"]],
  },
  functionNode("daily_update_parse_result", resultGroup, "Normalizar resultado DietPi", parseResult, 2, 800, 440, [["daily_update_result_test_out"], ["daily_update_core_request_out"]]),
  {
    id: "daily_update_result_test_out", type: "link out", z: TAB, g: resultGroup,
    name: "Resultado TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1085, y: 420, wires: [],
  },
  {
    id: "daily_update_core_request_out", type: "link out", z: TAB, g: resultGroup,
    name: "DietPi concluído → Core", mode: "link", links: ["daily_update_core_request_in"],
    x: 1085, y: 480, wires: [],
  },
  {
    id: coreGroup, type: "group", z: TAB,
    name: "3. SUBFLUXO Home Assistant Core: imagem estável e restart isolado",
    style: { label: true, color: "#d07a3f" },
    nodes: [
      "daily_update_core_architecture", "daily_update_core_request_in", "daily_update_core_test_request_in",
      "daily_update_core_prepare", "daily_update_core_route_test", "daily_update_core_request_host",
      "daily_update_core_request_ack", "daily_update_core_request_error", "daily_update_core_request_complete",
      "daily_update_core_request_test_out", "daily_update_core_result_startup", "daily_update_core_result_poll",
      "daily_update_core_read_result", "daily_update_core_read_error", "daily_update_core_read_complete",
      "daily_update_core_test_result_in", "daily_update_core_parse_result", "daily_update_core_result_test_out",
      "daily_update_containers_request_out", "daily_update_core_pending_in",
      "daily_update_core_pending_route_test", "daily_update_core_pending_status", "daily_update_core_pending_test_out",
    ],
    x: 44, y: 659, w: 1402, h: 402,
  },
  {
    id: "daily_update_core_architecture", type: "comment", z: TAB, g: coreGroup,
    name: "Core separado: resolve apenas ghcr.io/home-assistant/home-assistant:stable",
    info: "Somente o digest do serviço homeassistant pode mudar nesta etapa. Se houver mudança, apenas esse serviço é recriado; volumes, entidades, registros e Recorder são preservados.",
    x: 900, y: 680, wires: [],
  },
  {
    id: "daily_update_core_request_in", type: "link in", z: TAB, g: coreGroup,
    name: "Receber sucesso DietPi", links: ["daily_update_core_request_out"],
    x: 85, y: 780, wires: [["daily_update_core_prepare"]],
  },
  {
    id: "daily_update_core_pending_in", type: "link in", z: TAB, g: coreGroup,
    name: "Update Core detectado", links: ["daily_update_inventory_core_out"],
    x: 85, y: 720, wires: [["daily_update_core_pending_route_test"]],
  },
  {
    id: "daily_update_core_pending_route_test", type: "switch", z: TAB, g: coreGroup,
    name: "Detecção Core é TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 330, y: 720, wires: [["daily_update_core_pending_test_out"], ["daily_update_core_pending_status"]],
  },
  functionNode("daily_update_core_pending_status", coreGroup, "Registrar Core pendente", recordPendingUpdate("home_assistant_core", "aguarda backup"), 0, 610, 740, []),
  {
    id: "daily_update_core_pending_test_out", type: "link out", z: TAB, g: coreGroup,
    name: "Detecção Core TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 615, y: 700, wires: [],
  },
  {
    id: "daily_update_core_test_request_in", type: "link in", z: TAB, g: coreGroup,
    name: "Receber Core TESTE", links: ["daily_update_core_test_request_out"],
    x: 85, y: 840, wires: [["daily_update_core_prepare"]],
  },
  functionNode("daily_update_core_prepare", coreGroup, "Preparar etapa Core", prepareHostStage("home-assistant-core"), 1, 320, 810, [["daily_update_core_route_test"]]),
  {
    id: "daily_update_core_route_test", type: "switch", z: TAB, g: coreGroup,
    name: "Core: produção ou TESTE?", property: "_daily_update_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 580, y: 810, wires: [["daily_update_core_request_test_out"], ["daily_update_core_request_host"]],
  },
  {
    id: "daily_update_core_request_host", type: "exec", z: TAB, g: coreGroup,
    command: "/opt/request-host-update-stage.sh home-assistant-core", addpay: "", append: "", useSpawn: "false",
    timer: "30", winHide: false, oldrc: false, name: "Solicitar Core ao host",
    x: 900, y: 790,
    wires: [["daily_update_core_request_ack"], ["daily_update_core_request_error"], ["daily_update_core_request_complete"]],
  },
  functionNode("daily_update_core_request_ack", coreGroup, "Registrar solicitação Core", recordRequest, 0, 1210, 720, []),
  functionNode("daily_update_core_request_error", coreGroup, "Falha segura da ponte Core", recordExecError, 0, 1220, 780, []),
  functionNode("daily_update_core_request_complete", coreGroup, "Código da ponte Core", recordCompletion, 0, 1210, 840, []),
  {
    id: "daily_update_core_request_test_out", type: "link out", z: TAB, g: coreGroup,
    name: "Core TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 865, y: 850, wires: [],
  },
  {
    id: "daily_update_core_result_startup", type: "inject", z: TAB, g: coreGroup,
    name: "Core: ler ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "25", topic: "", payload: "", payloadType: "date",
    x: 190, y: 930, wires: [["daily_update_core_read_result"]],
  },
  {
    id: "daily_update_core_result_poll", type: "inject", z: TAB, g: coreGroup,
    name: "Core: resultado a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date",
    x: 210, y: 990, wires: [["daily_update_core_read_result"]],
  },
  {
    id: "daily_update_core_read_result", type: "exec", z: TAB, g: coreGroup,
    command: "/opt/read-host-update-stage-result.sh home-assistant-core", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado Core",
    x: 500, y: 960,
    wires: [["daily_update_core_parse_result"], ["daily_update_core_read_error"], ["daily_update_core_read_complete"]],
  },
  functionNode("daily_update_core_read_error", coreGroup, "Falha ao ler Core", recordExecError, 0, 790, 900, []),
  functionNode("daily_update_core_read_complete", coreGroup, "Código da leitura Core", recordCompletion, 0, 790, 1020, []),
  {
    id: "daily_update_core_test_result_in", type: "link in", z: TAB, g: coreGroup,
    name: "Receber resultado Core TESTE", links: ["daily_update_core_test_result_out"],
    x: 595, y: 900, wires: [["daily_update_core_parse_result"]],
  },
  functionNode("daily_update_core_parse_result", coreGroup, "Normalizar resultado Core", parseHostStageResult("home-assistant-core", "Core", true), 2, 850, 960, [["daily_update_core_result_test_out"], ["daily_update_containers_request_out"]]),
  {
    id: "daily_update_core_result_test_out", type: "link out", z: TAB, g: coreGroup,
    name: "Resultado Core TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1145, y: 930, wires: [],
  },
  {
    id: "daily_update_containers_request_out", type: "link out", z: TAB, g: coreGroup,
    name: "Core concluído → containers", mode: "link", links: ["daily_update_containers_request_in"],
    x: 1155, y: 990, wires: [],
  },
  {
    id: containersGroup, type: "group", z: TAB,
    name: "4. SUBFLUXO demais containers: reconciliar imagens sem o Core",
    style: { label: true, color: "#3f9d93" },
    nodes: [
      "daily_update_containers_architecture", "daily_update_containers_request_in", "daily_update_containers_test_request_in",
      "daily_update_containers_prepare", "daily_update_containers_route_test", "daily_update_containers_request_host",
      "daily_update_containers_request_ack", "daily_update_containers_request_error", "daily_update_containers_request_complete",
      "daily_update_containers_request_test_out", "daily_update_containers_result_startup", "daily_update_containers_result_poll",
      "daily_update_containers_read_result", "daily_update_containers_read_error", "daily_update_containers_read_complete",
      "daily_update_containers_test_result_in", "daily_update_containers_parse_result", "daily_update_containers_result_test_out",
      "daily_update_codex_cli_request_out",
    ],
    x: 44, y: 1099, w: 1402, h: 402,
  },
  {
    id: "daily_update_containers_architecture", type: "comment", z: TAB, g: containersGroup,
    name: "Portainer, MQTT, Matter, AppDaemon, Node-RED e Zigbee2MQTT; Core não entra aqui",
    info: "Cada digest é validado antes de recriar somente os serviços alterados. A manutenção segura de storage ocorre ao final desta última etapa.",
    x: 650, y: 1140, wires: [],
  },
  {
    id: "daily_update_containers_request_in", type: "link in", z: TAB, g: containersGroup,
    name: "Receber sucesso Core", links: ["daily_update_containers_request_out"],
    x: 85, y: 1220, wires: [["daily_update_containers_prepare"]],
  },
  {
    id: "daily_update_containers_test_request_in", type: "link in", z: TAB, g: containersGroup,
    name: "Receber containers TESTE", links: ["daily_update_containers_test_request_out"],
    x: 85, y: 1280, wires: [["daily_update_containers_prepare"]],
  },
  functionNode("daily_update_containers_prepare", containersGroup, "Preparar etapa containers", prepareHostStage("containers"), 1, 330, 1250, [["daily_update_containers_route_test"]]),
  {
    id: "daily_update_containers_route_test", type: "switch", z: TAB, g: containersGroup,
    name: "Containers: produção ou TESTE?", property: "_daily_update_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 610, y: 1250, wires: [["daily_update_containers_request_test_out"], ["daily_update_containers_request_host"]],
  },
  {
    id: "daily_update_containers_request_host", type: "exec", z: TAB, g: containersGroup,
    command: "/opt/request-host-update-stage.sh containers", addpay: "", append: "", useSpawn: "false",
    timer: "30", winHide: false, oldrc: false, name: "Solicitar containers ao host",
    x: 940, y: 1230,
    wires: [["daily_update_containers_request_ack"], ["daily_update_containers_request_error"], ["daily_update_containers_request_complete"]],
  },
  functionNode("daily_update_containers_request_ack", containersGroup, "Registrar solicitação containers", recordRequest, 0, 1240, 1160, []),
  functionNode("daily_update_containers_request_error", containersGroup, "Falha segura da ponte containers", recordExecError, 0, 1250, 1220, []),
  functionNode("daily_update_containers_request_complete", containersGroup, "Código da ponte containers", recordCompletion, 0, 1240, 1280, []),
  {
    id: "daily_update_containers_request_test_out", type: "link out", z: TAB, g: containersGroup,
    name: "Containers TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 900, y: 1290, wires: [],
  },
  {
    id: "daily_update_containers_result_startup", type: "inject", z: TAB, g: containersGroup,
    name: "Containers: ler ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "35", topic: "", payload: "", payloadType: "date",
    x: 210, y: 1370, wires: [["daily_update_containers_read_result"]],
  },
  {
    id: "daily_update_containers_result_poll", type: "inject", z: TAB, g: containersGroup,
    name: "Containers: resultado a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date",
    x: 230, y: 1430, wires: [["daily_update_containers_read_result"]],
  },
  {
    id: "daily_update_containers_read_result", type: "exec", z: TAB, g: containersGroup,
    command: "/opt/read-host-update-stage-result.sh containers", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado containers",
    x: 530, y: 1400,
    wires: [["daily_update_containers_parse_result"], ["daily_update_containers_read_error"], ["daily_update_containers_read_complete"]],
  },
  functionNode("daily_update_containers_read_error", containersGroup, "Falha ao ler containers", recordExecError, 0, 830, 1340, []),
  functionNode("daily_update_containers_read_complete", containersGroup, "Código da leitura containers", recordCompletion, 0, 830, 1460, []),
  {
    id: "daily_update_containers_test_result_in", type: "link in", z: TAB, g: containersGroup,
    name: "Receber resultado containers TESTE", links: ["daily_update_containers_test_result_out"],
    x: 645, y: 1340, wires: [["daily_update_containers_parse_result"]],
  },
  functionNode("daily_update_containers_parse_result", containersGroup, "Normalizar resultado containers", parseHostStageResult("containers", "Containers", true), 2, 900, 1400, [["daily_update_containers_result_test_out"], ["daily_update_codex_cli_request_out"]]),
  {
    id: "daily_update_containers_result_test_out", type: "link out", z: TAB, g: containersGroup,
    name: "Resultado containers TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1235, y: 1400, wires: [],
  },
  {
    id: "daily_update_codex_cli_request_out", type: "link out", z: TAB, g: containersGroup,
    name: "Containers concluídos → Codex CLI", mode: "link", links: ["daily_update_codex_cli_request_in"],
    x: 1240, y: 1460, wires: [],
  },
  {
    id: codexCliGroup, type: "group", z: TAB,
    name: "5. SUBFLUXO Codex CLI: versão exata, validação, restart e rollback",
    style: { label: true, color: "#5f78a8" },
    nodes: [
      "daily_update_codex_cli_architecture", "daily_update_codex_cli_request_in",
      "daily_update_codex_cli_manual", "daily_update_codex_cli_test_request",
      "daily_update_codex_cli_prepare", "daily_update_codex_cli_route_test",
      "daily_update_codex_cli_request_test_out", "daily_update_codex_cli_request_host",
      "daily_update_codex_cli_request_ack", "daily_update_codex_cli_request_error",
      "daily_update_codex_cli_request_complete", "daily_update_codex_cli_result_startup",
      "daily_update_codex_cli_result_poll", "daily_update_codex_cli_read_result",
      "daily_update_codex_cli_read_error", "daily_update_codex_cli_read_complete",
      "daily_update_codex_cli_test_success", "daily_update_codex_cli_test_failure",
      "daily_update_codex_cli_parse_result", "daily_update_codex_cli_result_test_out",
      "daily_update_dependency_chain_out",
    ],
    x: 44, y: 1539, w: 1402, h: 602,
  },
  {
    id: "daily_update_codex_cli_architecture", type: "comment", z: TAB, g: codexCliGroup,
    name: "POLÍTICA: versão exata, verificar binário e reiniciar somente o App Server",
    info: "A ponte do host resolve a versão publicada no registro npm, aceita somente semver válido e instala no prefixo pessoal .local. Se a verificação do binário falhar, tenta restaurar a versão anterior. Após update confirmado, valida o dono do socket Unix, encerra somente o App Server do Codex, inicia a nova versão e confirma o listener. Um marcador privado preserva a pendência se o handoff falhar. O Node-RED recebe somente lifecycle sanitizado.",
    x: 720, y: 1580, wires: [],
  },
  {
    id: "daily_update_codex_cli_request_in", type: "link in", z: TAB, g: codexCliGroup,
    name: "Receber sucesso dos containers", links: ["daily_update_codex_cli_request_out"],
    x: 85, y: 1660, wires: [["daily_update_codex_cli_prepare"]],
  },
  {
    id: "daily_update_codex_cli_manual", type: "inject", z: TAB, g: codexCliGroup,
    name: "Atualizar Codex CLI agora", props: [{ p: "payload", v: '{"stage":"manual"}', vt: "json" }],
    repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 210, y: 1720, wires: [["daily_update_codex_cli_prepare"]],
  },
  {
    id: "daily_update_codex_cli_test_request", type: "inject", z: TAB, g: codexCliGroup,
    name: "TESTE 5A: solicitar atualização", props: [
      { p: "payload", v: '{"stage":"containers","status":"success","test_mode":true}', vt: "json" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 220, y: 1780, wires: [["daily_update_codex_cli_prepare"]],
  },
  functionNode("daily_update_codex_cli_prepare", codexCliGroup, "Preparar etapa Codex CLI", prepareHostStage("codex-cli"), 1, 480, 1720, [["daily_update_codex_cli_route_test"]]),
  {
    id: "daily_update_codex_cli_route_test", type: "switch", z: TAB, g: codexCliGroup,
    name: "Codex CLI: produção ou TESTE?", property: "_daily_update_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 750, y: 1720, wires: [["daily_update_codex_cli_request_test_out"], ["daily_update_codex_cli_request_host"]],
  },
  {
    id: "daily_update_codex_cli_request_test_out", type: "link out", z: TAB, g: codexCliGroup,
    name: "Codex CLI TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1040, y: 1660, wires: [],
  },
  {
    id: "daily_update_codex_cli_request_host", type: "exec", z: TAB, g: codexCliGroup,
    command: "/opt/request-host-update-stage.sh codex-cli", addpay: "", append: "", useSpawn: "false",
    timer: "30", winHide: false, oldrc: false, name: "Solicitar atualização Codex CLI",
    x: 1030, y: 1760,
    wires: [["daily_update_codex_cli_request_ack"], ["daily_update_codex_cli_request_error"], ["daily_update_codex_cli_request_complete"]],
  },
  functionNode("daily_update_codex_cli_request_ack", codexCliGroup, "Registrar solicitação Codex CLI", recordRequest, 0, 1290, 1680, []),
  functionNode("daily_update_codex_cli_request_error", codexCliGroup, "Falha segura da ponte Codex CLI", recordExecError, 0, 1300, 1740, []),
  functionNode("daily_update_codex_cli_request_complete", codexCliGroup, "Código da ponte Codex CLI", recordCompletion, 0, 1290, 1800, []),
  {
    id: "daily_update_codex_cli_result_startup", type: "inject", z: TAB, g: codexCliGroup,
    name: "Codex CLI: ler ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "40", topic: "", payload: "", payloadType: "date",
    x: 200, y: 1900, wires: [["daily_update_codex_cli_read_result"]],
  },
  {
    id: "daily_update_codex_cli_result_poll", type: "inject", z: TAB, g: codexCliGroup,
    name: "Codex CLI: resultado a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: "0.1", topic: "", payload: "", payloadType: "date",
    x: 220, y: 1960, wires: [["daily_update_codex_cli_read_result"]],
  },
  {
    id: "daily_update_codex_cli_read_result", type: "exec", z: TAB, g: codexCliGroup,
    command: "/opt/read-host-update-stage-result.sh codex-cli", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado Codex CLI",
    x: 520, y: 1930,
    wires: [["daily_update_codex_cli_parse_result"], ["daily_update_codex_cli_read_error"], ["daily_update_codex_cli_read_complete"]],
  },
  functionNode("daily_update_codex_cli_read_error", codexCliGroup, "Falha ao ler Codex CLI", recordExecError, 0, 800, 1870, []),
  functionNode("daily_update_codex_cli_read_complete", codexCliGroup, "Código da leitura Codex CLI", recordCompletion, 0, 900, 2100, []),
  {
    id: "daily_update_codex_cli_test_success", type: "inject", z: TAB, g: codexCliGroup,
    name: "TESTE 5B: atualização concluída", props: [
      { p: "payload", v: "host-update stage=codex-cli status=success request_id=test-codex-cli stage_exit=0", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 650, y: 2020, wires: [["daily_update_codex_cli_parse_result"]],
  },
  {
    id: "daily_update_codex_cli_test_failure", type: "inject", z: TAB, g: codexCliGroup,
    name: "TESTE 5C: validação falhou", props: [
      { p: "payload", v: "host-update stage=codex-cli status=failed request_id=test-codex-cli-failed stage_exit=70 failure_stage=verify", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 640, y: 2080, wires: [["daily_update_codex_cli_parse_result"]],
  },
  functionNode("daily_update_codex_cli_parse_result", codexCliGroup, "Normalizar resultado Codex CLI", parseHostStageResult("codex-cli", "Codex CLI", true), 2, 940, 1990, [["daily_update_codex_cli_result_test_out"], ["daily_update_dependency_chain_out"]]),
  {
    id: "daily_update_codex_cli_result_test_out", type: "link out", z: TAB, g: codexCliGroup,
    name: "Resultado Codex CLI TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1260, y: 1960, wires: [],
  },
  {
    id: "daily_update_dependency_chain_out", type: "link out", z: TAB, g: codexCliGroup,
    name: "Codex CLI concluído → dependências", mode: "link", links: ["daily_update_dependency_chain_in"],
    x: 1260, y: 2020, wires: [],
  },
  {
    id: testGroup, type: "group", z: TAB,
    name: "6. TESTES manuais completos sem sudo, apt, Docker, npm, firmware ou reboot",
    style: { label: true, color: "#7d6ba8" },
    nodes: [
      "daily_update_test_instructions", "daily_update_test_reset", "daily_update_test_reset_state",
      "daily_update_test_request", "daily_update_test_failure", "daily_update_test_unavailable",
      "daily_update_core_test_request", "daily_update_core_test_request_out",
      "daily_update_core_test_result", "daily_update_core_test_result_out",
      "daily_update_containers_test_request", "daily_update_containers_test_request_out",
      "daily_update_containers_test_result", "daily_update_containers_test_result_out",
      "daily_update_test_request_out", "daily_update_test_result_out", "daily_update_dry_run_in",
      "daily_update_dry_run_terminal",
    ],
    x: 44, y: 659, w: 1402, h: 602,
  },
  {
    id: "daily_update_test_instructions", type: "comment", z: TAB, g: testGroup,
    name: "TESTE: 1) reset 2) solicitação, falha ou indisponibilidade 3) confira o terminal; todos os efeitos ficam bloqueados",
    info: "Os testes entram nos mesmos validadores, roteadores e parser da produção. O terminal grava simulated=true e dispatched=false.",
    x: 660, y: 700, wires: [],
  },
  {
    id: "daily_update_test_reset", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 1: reset", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 190, y: 780, wires: [["daily_update_test_reset_state"]],
  },
  functionNode("daily_update_test_reset_state", testGroup, "Resetar teste", resetTest, 0, 460, 780, []),
  {
    id: "daily_update_test_request", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 2A: ciclo após backup", props: [
      { p: "payload", v: '{"event":"git_backup_completed","status":"success","test_mode":true}', vt: "json" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 840, wires: [["daily_update_test_request_out"]],
  },
  {
    id: "daily_update_test_failure", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 2B: falha DietPi", props: [
      { p: "payload", v: "host-update stage=dietpi status=failed request_id=test-failed stage_exit=100 failure_stage=dietpi-update", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 200, y: 900, wires: [["daily_update_test_result_out"]],
  },
  {
    id: "daily_update_test_unavailable", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 2C: worker indisponível", props: [
      { p: "payload", v: "host-update stage=dietpi status=unavailable request_id=test-unavailable", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 960, wires: [["daily_update_test_result_out"]],
  },
  {
    id: "daily_update_core_test_request", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 3A: solicitar Core", props: [
      { p: "payload", v: '{"stage":"dietpi","status":"success","test_mode":true}', vt: "json" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 210, y: 1020, wires: [["daily_update_core_test_request_out"]],
  },
  {
    id: "daily_update_core_test_request_out", type: "link out", z: TAB, g: testGroup,
    name: "Core TESTE → subfluxo", mode: "link", links: ["daily_update_core_test_request_in"],
    x: 485, y: 1020, wires: [],
  },
  {
    id: "daily_update_core_test_result", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 3B: Core concluído", props: [
      { p: "payload", v: "host-update stage=home-assistant-core status=success request_id=test-core stage_exit=0", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 1080, wires: [["daily_update_core_test_result_out"]],
  },
  {
    id: "daily_update_core_test_result_out", type: "link out", z: TAB, g: testGroup,
    name: "Resultado Core TESTE → parser", mode: "link", links: ["daily_update_core_test_result_in"],
    x: 535, y: 1080, wires: [],
  },
  {
    id: "daily_update_containers_test_request", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 4A: solicitar containers", props: [
      { p: "payload", v: '{"stage":"home-assistant-core","status":"success","test_mode":true}', vt: "json" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 230, y: 1140, wires: [["daily_update_containers_test_request_out"]],
  },
  {
    id: "daily_update_containers_test_request_out", type: "link out", z: TAB, g: testGroup,
    name: "Containers TESTE → subfluxo", mode: "link", links: ["daily_update_containers_test_request_in"],
    x: 545, y: 1140, wires: [],
  },
  {
    id: "daily_update_containers_test_result", type: "inject", z: TAB, g: testGroup,
    name: "TESTE 4B: containers concluídos", props: [
      { p: "payload", v: "host-update stage=containers status=success request_id=test-containers stage_exit=0", vt: "str" },
      { p: "_daily_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 240, y: 1200, wires: [["daily_update_containers_test_result_out"]],
  },
  {
    id: "daily_update_containers_test_result_out", type: "link out", z: TAB, g: testGroup,
    name: "Resultado containers TESTE → parser", mode: "link", links: ["daily_update_containers_test_result_in"],
    x: 575, y: 1200, wires: [],
  },
  {
    id: "daily_update_test_request_out", type: "link out", z: TAB, g: testGroup,
    name: "Solicitação TESTE → validador", mode: "link", links: ["daily_update_test_request_in"],
    x: 505, y: 840, wires: [],
  },
  {
    id: "daily_update_test_result_out", type: "link out", z: TAB, g: testGroup,
    name: "Resultado TESTE → parser", mode: "link", links: ["daily_update_test_result_in"],
    x: 505, y: 930, wires: [],
  },
  {
    id: "daily_update_dry_run_in", type: "link in", z: TAB, g: testGroup,
    name: "Receber efeito TESTE", links: [
      "daily_update_request_test_out", "daily_update_result_test_out",
      "daily_update_core_request_test_out", "daily_update_core_result_test_out",
      "daily_update_containers_request_test_out", "daily_update_containers_result_test_out",
      "daily_update_codex_cli_request_test_out", "daily_update_codex_cli_result_test_out",
      "daily_update_inventory_summary_test_out", "daily_update_inventory_nonpending_test_out", "daily_update_core_pending_test_out",
      "daily_update_hacs_test_out", "daily_update_unknown_test_out", "daily_update_firmware_test_out", "daily_update_firmware_queue_test_out",
      "daily_update_alexa_media_test_out", "daily_update_alexa_media_result_dry_out",
      "daily_update_kia_test_out", "daily_update_kia_result_test_out",
      "daily_update_kia_codex_result_test_out", "daily_update_kia_promotion_result_test_out",
      "daily_update_dependency_test_out", "daily_update_dependency_blocked_test_out",
      "daily_update_dependency_result_test_out", "daily_update_dependency_summary_test_out",
    ],
    x: 715, y: 870, wires: [["daily_update_dry_run_terminal"]],
  },
  functionNode("daily_update_dry_run_terminal", testGroup, "TESTE FINAL: host simulado", dryRunTerminal, 0, 1030, 870, []),
  {
    id: inventoryGroup, type: "group", z: TAB,
    name: "7. ORQUESTRADOR update.*: parâmetros, inventário e roteamento canônico",
    style: { label: true, color: "#2f78a8" },
    nodes: [
      "daily_update_inventory_architecture", "daily_update_inventory_schedule", "daily_update_inventory_manual",
      "daily_update_inventory_apply_schedule", "daily_update_inventory_apply_manual",
      "daily_update_inventory_test", "daily_update_inventory_parameters", "daily_update_inventory_validate_policy",
      "daily_update_inventory_schedule_gate", "daily_update_inventory_schedule_delay_value",
      "daily_update_inventory_schedule_delay", "daily_update_inventory_schedule_loop_out",
      "daily_update_inventory_schedule_loop_in",
      "daily_update_inventory_route_source", "daily_update_inventory_read_ha", "daily_update_inventory_normalize",
      "daily_update_inventory_test_snapshot_out", "daily_update_inventory_real_snapshot_out", "daily_update_inventory_snapshot_in",
      "daily_update_inventory_state", "daily_update_inventory_classify", "daily_update_inventory_record",
      "daily_update_inventory_current", "daily_update_inventory_unavailable", "daily_update_inventory_nonpending_test_out",
      "daily_update_inventory_summary_test_out", "daily_update_inventory_kia_out", "daily_update_inventory_firmware_out",
      "daily_update_inventory_core_out", "daily_update_inventory_alexa_out", "daily_update_inventory_hacs_out", "daily_update_inventory_unknown_out",
    ],
    x: 44, y: 2240, w: 1582, h: 702,
  },
  {
    id: "daily_update_inventory_architecture", type: "comment", z: TAB, g: inventoryGroup,
    name: "PARÂMETROS: scan 30 min; Alexa/Kia auto=true só na janela 03:00; firmware auto=false; candidato 40 min",
    info: "A varredura periódica apenas detecta. A agenda diária das 03:00 ou o botão de produção concedem autorização efêmera. Alexa Media e Kia passam por auditoria, staging, backup, rollback e validação antes da instalação; demais HACS versionados continuam audit_only, Core usa stable e firmware físico permanece manual.",
    x: 800, y: 2280, wires: [],
  },
  {
    id: "daily_update_inventory_schedule", type: "inject", z: TAB, g: inventoryGroup,
    name: "Iniciar inventário periódico ao subir", props: [
      { p: "payload.source", v: "node_red_schedule", vt: "str" },
      { p: "_update_schedule_loop", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: true, onceDelay: "20", topic: "",
    payload: "", payloadType: "date", x: 220, y: 2380, wires: [["daily_update_inventory_parameters"]],
  },
  {
    id: "daily_update_inventory_manual", type: "inject", z: TAB, g: inventoryGroup,
    name: "Inventariar agora", props: [{ p: "payload.source", v: "manual", vt: "str" }],
    repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 190, y: 2440, wires: [["daily_update_inventory_parameters"]],
  },
  {
    id: "daily_update_inventory_apply_schedule", type: "inject", z: TAB, g: inventoryGroup,
    name: "03:00: auditar e instalar elegíveis", props: [
      { p: "payload.source", v: "daily_install_window", vt: "str" },
      { p: "_update_apply_authorized", v: "true", vt: "bool" },
    ], repeat: "", crontab: "00 03 * * *", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 240, y: 2500, wires: [["daily_update_inventory_parameters"]],
  },
  {
    id: "daily_update_inventory_apply_manual", type: "inject", z: TAB, g: inventoryGroup,
    name: "PRODUÇÃO: instalar elegíveis agora", props: [
      { p: "payload.source", v: "manual_install", vt: "str" },
      { p: "_update_apply_authorized", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 240, y: 2560, wires: [["daily_update_inventory_parameters"]],
  },
  {
    id: "daily_update_inventory_test", type: "inject", z: TAB, g: inventoryGroup,
    name: "TESTE: todas as classes", props: [
      { p: "payload", v: '[{"entity_id":"update.synthetic_kia_uvo","state":"on","attributes":{"friendly_name":"Kia UVO Hyundai Bluelink Update","installed_version":"v3.12.0","latest_version":"v3.13.0"}},{"entity_id":"update.synthetic_slzb_firmware","state":"on","attributes":{"friendly_name":"SLZB firmware","installed_version":"1","latest_version":"2"}},{"entity_id":"update.synthetic_home_assistant_core","state":"on","attributes":{"friendly_name":"Home Assistant Core Update","installed_version":"1","latest_version":"2"}},{"entity_id":"update.alexa_media_player_update","state":"on","attributes":{"friendly_name":"Alexa Media Player Update","installed_version":"v5.16.0","latest_version":"v5.16.1"}},{"entity_id":"update.synthetic_hacs","state":"on","attributes":{"friendly_name":"HACS Update","installed_version":"1","latest_version":"2"}},{"entity_id":"update.synthetic_unknown","state":"on","attributes":{"friendly_name":"Unknown Update","installed_version":"1","latest_version":"2"}},{"entity_id":"update.synthetic_unavailable","state":"unavailable","attributes":{"friendly_name":"Unknown unavailable"}}]', vt: "json" },
      { p: "_ha_updates_test", v: "true", vt: "bool" },
      { p: "_update_apply_authorized", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 210, y: 2620, wires: [["daily_update_inventory_parameters"]],
  },
  {
    id: "daily_update_inventory_parameters", type: "change", z: TAB, g: inventoryGroup,
    name: "PARÂMETROS visuais de updates", rules: [{
      t: "set", p: "update_policy", pt: "msg",
      to: '{"version":1,"scan_interval_minutes":30,"device_firmware_auto":false,"versioned_hacs_auto_apply":true,"kia_uvo_auto_apply":true,"manual_candidate_max_age_minutes":40}', tot: "json",
    }], action: "", property: "", from: "", to: "", reg: false,
    x: 500, y: 2440, wires: [["daily_update_inventory_validate_policy"]],
  },
  functionNode("daily_update_inventory_validate_policy", inventoryGroup, "Validar e preservar último válido", validateUpdatePolicy, 1, 800, 2440, [["daily_update_inventory_route_source", "daily_update_inventory_schedule_gate"]]),
  {
    id: "daily_update_inventory_schedule_gate", type: "switch", z: TAB, g: inventoryGroup,
    name: "Agendar próxima varredura?", property: "_update_schedule_loop", propertyType: "msg",
    rules: [{ t: "true" }], checkall: "true", repair: false, outputs: 1,
    x: 1050, y: 2500, wires: [["daily_update_inventory_schedule_delay_value"]],
  },
  {
    id: "daily_update_inventory_schedule_delay_value", type: "change", z: TAB, g: inventoryGroup,
    name: "Aplicar intervalo validado (min)", rules: [{
      t: "set", p: "delay", pt: "msg",
      to: "$number(update_policy.scan_interval_minutes) * 60000", tot: "jsonata",
    }], action: "", property: "", from: "", to: "", reg: false,
    x: 1320, y: 2500, wires: [["daily_update_inventory_schedule_delay"]],
  },
  {
    id: "daily_update_inventory_schedule_delay", type: "delay", z: TAB, g: inventoryGroup,
    name: "Aguardar intervalo visual", pauseType: "delayv", timeout: "30", timeoutUnits: "minutes",
    rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5",
    randomUnits: "seconds", drop: false, allowrate: false, outputs: 1,
    x: 1430, y: 2560, wires: [["daily_update_inventory_schedule_loop_out"]],
  },
  {
    id: "daily_update_inventory_schedule_loop_out", type: "link out", z: TAB, g: inventoryGroup,
    name: "Próxima varredura → parâmetros", mode: "link", links: ["daily_update_inventory_schedule_loop_in"],
    x: 1600, y: 2560, wires: [],
  },
  {
    id: "daily_update_inventory_schedule_loop_in", type: "link in", z: TAB, g: inventoryGroup,
    name: "Receber próxima varredura", links: ["daily_update_inventory_schedule_loop_out"],
    x: 85, y: 2560, wires: [["daily_update_inventory_parameters"]],
  },
  {
    id: "daily_update_inventory_route_source", type: "switch", z: TAB, g: inventoryGroup,
    name: "Fonte real ou TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1080, y: 2440, wires: [["daily_update_inventory_test_snapshot_out"], ["daily_update_inventory_read_ha"]],
  },
  {
    id: "daily_update_inventory_read_ha", type: "ha-api", z: TAB, g: inventoryGroup,
    name: "FONTE: estados update.* do HA", server: SERVER, version: 1, debugenabled: false,
    protocol: "websocket", method: "get", path: "", data: '{"type":"get_states"}', dataType: "json",
    responseType: "json", outputProperties: [{ property: "ha_update_states", propertyType: "msg", value: "", valueType: "results" }],
    x: 1360, y: 2400, wires: [["daily_update_inventory_real_snapshot_out"]],
  },
  {
    id: "daily_update_inventory_test_snapshot_out", type: "link out", z: TAB, g: inventoryGroup,
    name: "Snapshot TESTE → normalização", mode: "link", links: ["daily_update_inventory_snapshot_in"], x: 1320, y: 2480, wires: [],
  },
  {
    id: "daily_update_inventory_real_snapshot_out", type: "link out", z: TAB, g: inventoryGroup,
    name: "Snapshot HA → normalização", mode: "link", links: ["daily_update_inventory_snapshot_in"], x: 1540, y: 2400, wires: [],
  },
  {
    id: "daily_update_inventory_snapshot_in", type: "link in", z: TAB, g: inventoryGroup,
    name: "Receber snapshot para normalizar", links: ["daily_update_inventory_test_snapshot_out", "daily_update_inventory_real_snapshot_out"],
    x: 85, y: 2620, wires: [["daily_update_inventory_normalize"]],
  },
  functionNode("daily_update_inventory_normalize", inventoryGroup, "Adaptar estrutura update.*", normalizeUpdateInventory, 2, 410, 2620, [["daily_update_inventory_state"], ["daily_update_inventory_record"]]),
  {
    id: "daily_update_inventory_state", type: "switch", z: TAB, g: inventoryGroup,
    name: "ESTADO: pendente / indisponível / atual", property: "payload.state_class", propertyType: "msg",
    rules: [{ t: "eq", v: "pending", vt: "str" }, { t: "eq", v: "unavailable", vt: "str" }, { t: "else" }],
    checkall: "true", repair: false, outputs: 3, x: 720, y: 2580,
    wires: [["daily_update_inventory_classify"], ["daily_update_inventory_unavailable"], ["daily_update_inventory_current"]],
  },
  {
    id: "daily_update_inventory_classify", type: "switch", z: TAB, g: inventoryGroup,
    name: "CLASSIFICAR: Bluelink / firmware / Core / Alexa / HACS / desconhecido", property: "payload.search_key", propertyType: "msg",
    rules: [
      { t: "regex", v: "kia_uvo|hyundai|bluelink|\\buvo\\b", vt: "str", case: false },
      { t: "regex", v: "firmware|slzb", vt: "str", case: false },
      { t: "regex", v: "home_assistant_core|home assistant core", vt: "str", case: false },
      { t: "regex", v: "alexa_media_player_update|alexa media player update", vt: "str", case: false },
      { t: "regex", v: "\\bhacs\\b|local_tuya|local tuya|moni_mobile|moni mobile|tuya_vacuum_maps|tuya vacuum maps", vt: "str", case: false },
      { t: "else" },
    ], checkall: "true", repair: false, outputs: 6, x: 1040, y: 2580,
    wires: [["daily_update_inventory_kia_out"], ["daily_update_inventory_firmware_out"], ["daily_update_inventory_core_out"], ["daily_update_inventory_alexa_out"], ["daily_update_inventory_hacs_out"], ["daily_update_inventory_unknown_out"]],
  },
  functionNode("daily_update_inventory_record", inventoryGroup, "Publicar resumo canônico", recordUpdateInventory, 1, 450, 2700, [["daily_update_inventory_summary_test_out"]]),
  functionNode("daily_update_inventory_unavailable", inventoryGroup, "Registrar fonte update indisponível", `node.status({fill:"yellow",shape:"ring",text:msg.payload.entity_id+" indisponível"}); return msg._ha_updates_test === true ? msg : null;`, 1, 750, 2660, [["daily_update_inventory_nonpending_test_out"]]),
  functionNode("daily_update_inventory_current", inventoryGroup, "Confirmar fonte update atual", `node.status({fill:"green",shape:"dot",text:"fontes atuais"}); return msg._ha_updates_test === true ? msg : null;`, 1, 750, 2720, [["daily_update_inventory_nonpending_test_out"]]),
  {
    id: "daily_update_inventory_summary_test_out", type: "link out", z: TAB, g: inventoryGroup,
    name: "Resumo TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 600, y: 2740, wires: [],
  },
  {
    id: "daily_update_inventory_nonpending_test_out", type: "link out", z: TAB, g: inventoryGroup,
    name: "Estado não pendente TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1050, y: 2740, wires: [],
  },
  ...[
    ["daily_update_inventory_kia_out", "Bluelink → subfluxo HACS", "daily_update_kia_schedule", 1510, 2480],
    ["daily_update_inventory_firmware_out", "Firmware → subfluxo físico", "daily_update_firmware_in", 1510, 2530],
    ["daily_update_inventory_core_out", "Core → subfluxo Core", "daily_update_core_pending_in", 1510, 2580],
    ["daily_update_inventory_alexa_out", "Alexa → atualização auditada", "daily_update_alexa_media_in", 1510, 2630],
    ["daily_update_inventory_hacs_out", "Demais HACS → auditoria", "daily_update_hacs_in", 1510, 2680],
    ["daily_update_inventory_unknown_out", "Desconhecido → bloqueio", "daily_update_unknown_in", 1510, 2730],
  ].map(([id, name, target, x, y]) => ({ id, type: "link out", z: TAB, g: inventoryGroup, name, mode: "link", links: [target], x, y, wires: [] })),
  {
    id: hacsGroup, type: "group", z: TAB,
    name: "8. SUBFLUXO HACS versionado: detectar e exigir auditoria upstream",
    style: { label: true, color: "#b68c3a" },
    nodes: ["daily_update_hacs_in", "daily_update_hacs_state", "daily_update_hacs_test_gate", "daily_update_hacs_rbe", "daily_update_hacs_pending", "daily_update_hacs_current", "daily_update_hacs_unavailable", "daily_update_hacs_test_out"],
    x: 44, y: 2820, w: 882, h: 302,
  },
  {
    id: "daily_update_hacs_in", type: "link in", z: TAB, g: hacsGroup,
    name: "Receber integração HACS", links: ["daily_update_inventory_hacs_out"], x: 85, y: 2920, wires: [["daily_update_hacs_state"]],
  },
  {
    id: "daily_update_hacs_state", type: "switch", z: TAB, g: hacsGroup,
    name: "Estado HACS pendente / indisponível / atual", property: "payload.state_class", propertyType: "msg",
    rules: [{ t: "eq", v: "pending", vt: "str" }, { t: "eq", v: "unavailable", vt: "str" }, { t: "else" }],
    checkall: "true", repair: false, outputs: 3, x: 330, y: 2920,
    wires: [["daily_update_hacs_test_gate"], ["daily_update_hacs_unavailable"], ["daily_update_hacs_current"]],
  },
  {
    id: "daily_update_hacs_test_gate", type: "switch", z: TAB, g: hacsGroup,
    name: "HACS é TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 610, y: 2880, wires: [["daily_update_hacs_test_out"], ["daily_update_hacs_rbe"]],
  },
  {
    id: "daily_update_hacs_rbe", type: "rbe", z: TAB, g: hacsGroup,
    name: "Deduplicar HACS por entidade/versão", func: "rbe", gap: "", start: "", inout: "out",
    septopics: true, property: "payload.signature", topi: "topic", x: 650, y: 2940,
    wires: [["daily_update_hacs_pending"]],
  },
  functionNode("daily_update_hacs_pending", hacsGroup, "BLOQUEAR instalação cega; auditar", recordPendingUpdate("hacs_vendored", "auditoria obrigatória"), 0, 780, 3020, []),
  functionNode("daily_update_hacs_unavailable", hacsGroup, "Registrar HACS indisponível", recordPendingUpdate("hacs_unavailable", "indisponível"), 0, 470, 3000, []),
  functionNode("daily_update_hacs_current", hacsGroup, "Confirmar HACS atual", `node.status({fill:"green",shape:"dot",text:"versionado atual"}); return null;`, 0, 470, 3060, []),
  {
    id: "daily_update_hacs_test_out", type: "link out", z: TAB, g: hacsGroup,
    name: "HACS TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 825, y: 2860, wires: [],
  },
  {
    id: unknownGroup, type: "group", z: TAB,
    name: "9. SUBFLUXO desconhecido: fail closed sem update.install",
    style: { label: true, color: "#8a8a8a" },
    nodes: ["daily_update_unknown_in", "daily_update_unknown_test_gate", "daily_update_unknown_rbe", "daily_update_unknown_pending", "daily_update_unknown_test_out"],
    x: 984, y: 2820, w: 642, h: 302,
  },
  {
    id: "daily_update_unknown_in", type: "link in", z: TAB, g: unknownGroup,
    name: "Receber update desconhecido", links: ["daily_update_inventory_unknown_out"], x: 1025, y: 2920, wires: [["daily_update_unknown_test_gate"]],
  },
  {
    id: "daily_update_unknown_test_gate", type: "switch", z: TAB, g: unknownGroup,
    name: "Desconhecido é TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1260, y: 2920, wires: [["daily_update_unknown_test_out"], ["daily_update_unknown_rbe"]],
  },
  {
    id: "daily_update_unknown_rbe", type: "rbe", z: TAB, g: unknownGroup,
    name: "Deduplicar desconhecido", func: "rbe", gap: "", start: "", inout: "out",
    septopics: true, property: "payload.signature", topi: "topic", x: 1290, y: 2980,
    wires: [["daily_update_unknown_pending"]],
  },
  functionNode("daily_update_unknown_pending", unknownGroup, "BLOQUEAR e registrar para classificação", recordPendingUpdate("unknown", "classificação necessária"), 0, 1430, 3060, []),
  {
    id: "daily_update_unknown_test_out", type: "link out", z: TAB, g: unknownGroup,
    name: "Desconhecido TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1510, y: 2880, wires: [],
  },
  {
    id: alexaGroup, type: "group", z: TAB,
    name: "10. SUBFLUXO Alexa Media: tag exata, auditoria, overlay, rollback e validação",
    style: { label: true, color: "#6e78b8" },
    nodes: [
      "daily_update_alexa_media_architecture", "daily_update_alexa_media_in",
      "daily_update_alexa_media_authorized", "daily_update_alexa_media_policy",
      "daily_update_alexa_media_pending_rbe", "daily_update_alexa_media_pending",
      "daily_update_alexa_media_prepare", "daily_update_alexa_media_final_gate",
      "daily_update_alexa_media_test_out", "daily_update_alexa_media_request",
      "daily_update_alexa_media_request_ack", "daily_update_alexa_media_request_error",
      "daily_update_alexa_media_request_complete", "daily_update_alexa_media_result_startup",
      "daily_update_alexa_media_result_poll", "daily_update_alexa_media_read_result",
      "daily_update_alexa_media_read_error", "daily_update_alexa_media_read_complete",
      "daily_update_alexa_media_parse_result", "daily_update_alexa_media_result_test",
      "daily_update_alexa_media_result_test_out", "daily_update_alexa_media_result_test_in",
      "daily_update_alexa_media_result_dry_out", "daily_update_alexa_media_backup_out",
    ],
    x: 44, y: 3380, w: 1582, h: 542,
  },
  {
    id: "daily_update_alexa_media_architecture", type: "comment", z: TAB, g: alexaGroup,
    name: "Só instala na janela autorizada: resolve tag/commit, preserva licença e delta, valida staging e runtime",
    info: "A varredura comum apenas registra a pendência. Às 03:00 ou pelo botão PRODUÇÃO, o host compara a base oficial byte a byte, aceita somente deltas allowlisted, cria backup, instala a versão exata via HACS, reaplica o staging e confirma registros, Recorder e entidades. Qualquer falha restaura a versão anterior.",
    x: 800, y: 3420, wires: [],
  },
  {
    id: "daily_update_alexa_media_in", type: "link in", z: TAB, g: alexaGroup,
    name: "Receber Alexa Media pendente", links: ["daily_update_inventory_alexa_out"],
    x: 85, y: 3520, wires: [["daily_update_alexa_media_authorized"]],
  },
  {
    id: "daily_update_alexa_media_authorized", type: "switch", z: TAB, g: alexaGroup,
    name: "Janela de instalação autorizada?", property: "_update_apply_authorized", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 350, y: 3520, wires: [["daily_update_alexa_media_policy"], ["daily_update_alexa_media_pending_rbe"]],
  },
  {
    id: "daily_update_alexa_media_policy", type: "switch", z: TAB, g: alexaGroup,
    name: "PARÂMETRO Alexa auto?", property: "update_policy.versioned_hacs_auto_apply", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 650, y: 3480, wires: [["daily_update_alexa_media_prepare"], ["daily_update_alexa_media_pending_rbe"]],
  },
  {
    id: "daily_update_alexa_media_pending_rbe", type: "rbe", z: TAB, g: alexaGroup,
    name: "Deduplicar pendência Alexa", func: "rbe", gap: "", start: "", inout: "out",
    septopics: true, property: "payload.signature", topi: "topic", x: 680, y: 3560,
    wires: [["daily_update_alexa_media_pending"]],
  },
  functionNode("daily_update_alexa_media_pending", alexaGroup, "Aguardar janela autorizada", recordPendingUpdate("alexa_media", "aguarda 03:00/autorização"), 0, 930, 3560, []),
  functionNode("daily_update_alexa_media_prepare", alexaGroup, "Preparar versão exata", prepareAlexaMediaRequest, 1, 920, 3480, [["daily_update_alexa_media_final_gate"]]),
  {
    id: "daily_update_alexa_media_final_gate", type: "switch", z: TAB, g: alexaGroup,
    name: "GATE FINAL: produção ou TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1190, y: 3480, wires: [["daily_update_alexa_media_test_out"], ["daily_update_alexa_media_request"]],
  },
  {
    id: "daily_update_alexa_media_test_out", type: "link out", z: TAB, g: alexaGroup,
    name: "Alexa TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1510, y: 3440, wires: [],
  },
  {
    id: "daily_update_alexa_media_request", type: "exec", z: TAB, g: alexaGroup,
    command: "/opt/request-host-alexa-media-update.sh", addpay: "payload", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Solicitar atualização auditada ao host", x: 1450, y: 3520,
    wires: [["daily_update_alexa_media_request_ack"], ["daily_update_alexa_media_request_error"], ["daily_update_alexa_media_request_complete"]],
  },
  functionNode("daily_update_alexa_media_request_ack", alexaGroup, "Registrar solicitação Alexa", recordAlexaMediaRequest, 0, 1470, 3580, []),
  functionNode("daily_update_alexa_media_request_error", alexaGroup, "Falha segura da ponte Alexa", recordExecError, 0, 1740, 3620, []),
  functionNode("daily_update_alexa_media_request_complete", alexaGroup, "Código da ponte Alexa", recordCompletion, 0, 1470, 3640, []),
  {
    id: "daily_update_alexa_media_result_startup", type: "inject", z: TAB, g: alexaGroup,
    name: "Alexa: ler ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "55", topic: "", payload: "", payloadType: "date",
    x: 200, y: 3720, wires: [["daily_update_alexa_media_read_result"]],
  },
  {
    id: "daily_update_alexa_media_result_poll", type: "inject", z: TAB, g: alexaGroup,
    name: "Alexa: resultado a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 220, y: 3780, wires: [["daily_update_alexa_media_read_result"]],
  },
  {
    id: "daily_update_alexa_media_read_result", type: "exec", z: TAB, g: alexaGroup,
    command: "/opt/read-host-alexa-media-update-result.sh", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado Alexa seguro", x: 510, y: 3750,
    wires: [["daily_update_alexa_media_parse_result"], ["daily_update_alexa_media_read_error"], ["daily_update_alexa_media_read_complete"]],
  },
  functionNode("daily_update_alexa_media_read_error", alexaGroup, "Falha ao ler Alexa", recordExecError, 0, 790, 3700, []),
  functionNode("daily_update_alexa_media_read_complete", alexaGroup, "Código da leitura Alexa", recordCompletion, 0, 790, 3820, []),
  functionNode("daily_update_alexa_media_parse_result", alexaGroup, "Validar resultado e solicitar backup", parseAlexaMediaResult, 2, 830, 3750, [["daily_update_alexa_media_result_dry_out"], ["daily_update_alexa_media_backup_out"]]),
  {
    id: "daily_update_alexa_media_result_test", type: "inject", z: TAB, g: alexaGroup,
    name: "TESTE: resultado sem efeito", props: [
      { p: "payload", v: "alexa-media-update status=success target=v5.16.1 request_id=test", vt: "str" },
      { p: "_alexa_media_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 1070, y: 3860, wires: [["daily_update_alexa_media_result_test_out"]],
  },
  {
    id: "daily_update_alexa_media_result_test_out", type: "link out", z: TAB, g: alexaGroup,
    name: "Resultado Alexa TESTE → parser", mode: "link", links: ["daily_update_alexa_media_result_test_in"], x: 1350, y: 3860, wires: [],
  },
  {
    id: "daily_update_alexa_media_result_test_in", type: "link in", z: TAB, g: alexaGroup,
    name: "Receber resultado Alexa TESTE", links: ["daily_update_alexa_media_result_test_out"], x: 575, y: 3860, wires: [["daily_update_alexa_media_parse_result"]],
  },
  {
    id: "daily_update_alexa_media_result_dry_out", type: "link out", z: TAB, g: alexaGroup,
    name: "Resultado Alexa TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1110, y: 3710, wires: [],
  },
  {
    id: "daily_update_alexa_media_backup_out", type: "link out", z: TAB, g: alexaGroup,
    name: "Alexa validada → backup Git", mode: "link", links: ["git_backup_request_in"], x: 1130, y: 3790, wires: [],
  },
  {
    id: firmwareGroup, type: "group", z: TAB,
    name: "11. SUBFLUXO firmware físico: automático desligado; aplicação manual explícita",
    style: { label: true, color: "#c45a50" },
    nodes: [
      "daily_update_firmware_architecture", "daily_update_firmware_in", "daily_update_firmware_state",
      "daily_update_firmware_auto", "daily_update_firmware_manual_test_gate", "daily_update_firmware_store",
      "daily_update_firmware_pending_rbe", "daily_update_firmware_pending", "daily_update_firmware_current", "daily_update_firmware_unavailable",
      "daily_update_firmware_manual", "daily_update_firmware_take_candidate", "daily_update_firmware_fresh",
      "daily_update_firmware_test_auto", "daily_update_firmware_final_test_gate", "daily_update_firmware_install",
      "daily_update_firmware_installed", "daily_update_firmware_test_out", "daily_update_firmware_invalid",
      "daily_update_firmware_auto_effect_out", "daily_update_firmware_manual_effect_out",
      "daily_update_firmware_test_effect_out", "daily_update_firmware_effect_in", "daily_update_firmware_queue_test_out",
    ],
    x: 44, y: 3180, w: 1582, h: 522,
  },
  {
    id: "daily_update_firmware_architecture", type: "comment", z: TAB, g: firmwareGroup,
    name: "Firmware pode interromper Zigbee/Z-Wave; padrão auto=false. Botão consome candidato visto há no máximo 40 min",
    info: "O inventário gerencia e deduplica firmware, mas não confunde equipamento físico com update de software. Para habilitar automação, edite o parâmetro visual; o gate final continua separando produção e TESTE.",
    x: 800, y: 3220, wires: [],
  },
  {
    id: "daily_update_firmware_in", type: "link in", z: TAB, g: firmwareGroup,
    name: "Receber firmware", links: ["daily_update_inventory_firmware_out"], x: 85, y: 3340, wires: [["daily_update_firmware_state"]],
  },
  {
    id: "daily_update_firmware_state", type: "switch", z: TAB, g: firmwareGroup,
    name: "Firmware pendente / indisponível / atual", property: "payload.state_class", propertyType: "msg",
    rules: [{ t: "eq", v: "pending", vt: "str" }, { t: "eq", v: "unavailable", vt: "str" }, { t: "else" }],
    checkall: "true", repair: false, outputs: 3, x: 320, y: 3340,
    wires: [["daily_update_firmware_auto"], ["daily_update_firmware_unavailable"], ["daily_update_firmware_current"]],
  },
  {
    id: "daily_update_firmware_auto", type: "switch", z: TAB, g: firmwareGroup,
    name: "PARÂMETRO firmware automático?", property: "update_policy.device_firmware_auto", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 650, y: 3300, wires: [["daily_update_firmware_auto_effect_out"], ["daily_update_firmware_manual_test_gate"]],
  },
  {
    id: "daily_update_firmware_manual_test_gate", type: "switch", z: TAB, g: firmwareGroup,
    name: "Fila manual é TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 940, y: 3340, wires: [["daily_update_firmware_queue_test_out"], ["daily_update_firmware_store"]],
  },
  functionNode("daily_update_firmware_store", firmwareGroup, "Enfileirar candidato por entidade", queueFirmwareCandidate, 1, 1210, 3340, [["daily_update_firmware_pending_rbe"]]),
  {
    id: "daily_update_firmware_pending_rbe", type: "rbe", z: TAB, g: firmwareGroup,
    name: "Deduplicar aviso de firmware", func: "rbe", gap: "", start: "", inout: "out",
    septopics: true, property: "payload.signature", topi: "topic", x: 1270, y: 3400,
    wires: [["daily_update_firmware_pending"]],
  },
  functionNode("daily_update_firmware_pending", firmwareGroup, "Mostrar firmware aguardando decisão", recordPendingUpdate("device_firmware", "manual pendente"), 0, 1490, 3340, []),
  functionNode("daily_update_firmware_unavailable", firmwareGroup, "Firmware indisponível", recordPendingUpdate("device_firmware", "fonte indisponível"), 0, 650, 3420, []),
  functionNode("daily_update_firmware_current", firmwareGroup, "Firmware atual", `node.status({fill:"green",shape:"dot",text:"firmware atual"}); return null;`, 0, 620, 3480, []),
  {
    id: "daily_update_firmware_manual", type: "inject", z: TAB, g: firmwareGroup,
    name: "PRODUÇÃO: instalar firmware pendente", props: [{ p: "_firmware_manual_authorized", v: "true", vt: "bool" }],
    repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 240, y: 3580, wires: [["daily_update_firmware_take_candidate"]],
  },
  functionNode("daily_update_firmware_take_candidate", firmwareGroup, "Consumir próximo candidato uma vez", takeFirmwareCandidate, 1, 540, 3580, [["daily_update_firmware_fresh"]]),
  {
    id: "daily_update_firmware_fresh", type: "switch", z: TAB, g: firmwareGroup,
    name: "Candidato existe e tem ≤ 40 min?", property: "$exists(payload.entity_id) and $number(payload.observed_at) >= $millis() - (update_policy.manual_candidate_max_age_minutes * 60000)", propertyType: "jsonata",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 850, y: 3580, wires: [["daily_update_firmware_manual_effect_out"], ["daily_update_firmware_invalid"]],
  },
  {
    id: "daily_update_firmware_test_auto", type: "inject", z: TAB, g: firmwareGroup,
    name: "TESTE: auto chega ao gate final", props: [
      { p: "payload", v: '{"entity_id":"update.synthetic_slzb_firmware","observed_at":4102444800000,"state_class":"pending","latest_version":"2","test_mode":true}', vt: "json" },
      { p: "_ha_updates_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 260, y: 3640, wires: [["daily_update_firmware_test_effect_out"]],
  },
  {
    id: "daily_update_firmware_auto_effect_out", type: "link out", z: TAB, g: firmwareGroup,
    name: "Automático habilitado → gate final", mode: "link", links: ["daily_update_firmware_effect_in"], x: 900, y: 3280, wires: [],
  },
  {
    id: "daily_update_firmware_manual_effect_out", type: "link out", z: TAB, g: firmwareGroup,
    name: "Manual válido → gate final", mode: "link", links: ["daily_update_firmware_effect_in"], x: 1070, y: 3560, wires: [],
  },
  {
    id: "daily_update_firmware_test_effect_out", type: "link out", z: TAB, g: firmwareGroup,
    name: "Efeito TESTE → gate final", mode: "link", links: ["daily_update_firmware_effect_in"], x: 520, y: 3640, wires: [],
  },
  {
    id: "daily_update_firmware_effect_in", type: "link in", z: TAB, g: firmwareGroup,
    name: "Receber intenção de instalar", links: ["daily_update_firmware_auto_effect_out", "daily_update_firmware_manual_effect_out", "daily_update_firmware_test_effect_out"],
    x: 1095, y: 3520, wires: [["daily_update_firmware_final_test_gate"]],
  },
  {
    id: "daily_update_firmware_queue_test_out", type: "link out", z: TAB, g: firmwareGroup,
    name: "Fila manual TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1190, y: 3300, wires: [],
  },
  {
    id: "daily_update_firmware_final_test_gate", type: "switch", z: TAB, g: firmwareGroup,
    name: "GATE FINAL: produção ou TESTE?", property: "_ha_updates_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1290, y: 3520, wires: [["daily_update_firmware_test_out"], ["daily_update_firmware_install"]],
  },
  {
    id: "daily_update_firmware_install", type: "api-call-service", z: TAB, g: firmwareGroup,
    name: "EFEITO: update.install do firmware", server: SERVER, version: 7, debugenabled: false,
    action: "update.install", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
    data: '{"entity_id":payload.entity_id}', dataType: "jsonata", mergeContext: "", mustacheAltTags: false,
    outputProperties: [], queue: "none", blockInputOverrides: true, domain: "update", service: "install",
    x: 1480, y: 3580, wires: [["daily_update_firmware_installed"]],
  },
  functionNode("daily_update_firmware_installed", firmwareGroup, "Registrar comando aceito", `node.status({fill:"green",shape:"dot",text:"comando enviado ao HA"}); return null;`, 0, 1460, 3640, []),
  functionNode("daily_update_firmware_invalid", firmwareGroup, "Rejeitar candidato ausente/antigo", `node.status({fill:"yellow",shape:"ring",text:"inventarie novamente"}); return null;`, 0, 870, 3660, []),
  {
    id: "daily_update_firmware_test_out", type: "link out", z: TAB, g: firmwareGroup,
    name: "Firmware TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1510, y: 3500, wires: [],
  },
  {
    id: kiaUpdateGroup, type: "group", z: TAB,
    name: "12. SUBFLUXO HACS Bluelink: alvo exato e promoção segura autorizada",
    style: { label: true, color: "#b58b3f" },
    nodes: [
      "daily_update_kia_architecture", "daily_update_kia_schedule", "daily_update_kia_authorized",
      "daily_update_kia_auto_policy", "daily_update_kia_mode_audit", "daily_update_kia_mode_install",
      "daily_update_kia_test_request", "daily_update_kia_test_request_route_out",
      "daily_update_kia_test_request_route_in", "daily_update_kia_prepare", "daily_update_kia_route_test",
      "daily_update_kia_request_host", "daily_update_kia_request_ack", "daily_update_kia_request_error",
      "daily_update_kia_request_complete", "daily_update_kia_test_out", "daily_update_kia_result_startup",
      "daily_update_kia_result_poll", "daily_update_kia_read_result", "daily_update_kia_read_error",
      "daily_update_kia_read_complete", "daily_update_kia_parse_result", "daily_update_kia_test_result",
      "daily_update_kia_test_result_out", "daily_update_kia_test_result_in", "daily_update_kia_result_test_out",
      "daily_update_kia_codex_request_out",
    ],
    x: 44, y: 1059, w: 1402, h: 552,
  },
  {
    id: "daily_update_kia_architecture", type: "comment", z: TAB, g: kiaUpdateGroup,
    name: "Inventário passa a versão exata; janela autorizada promove candidato compatível ou reconciliado pelo Codex",
    info: "A varredura comum executa somente staging. Às 03:00 ou pelo botão PRODUÇÃO, o alvo exato detectado pelo HA segue para o worker Codex, inclusive quando o patch aplica limpo; o host revalida, aplica com backup/rollback, confirma o runtime e então envia main.",
    x: 670, y: 1100, wires: [],
  },
  {
    id: "daily_update_kia_schedule", type: "link in", z: TAB, g: kiaUpdateGroup,
    name: "Update Bluelink detectado", links: ["daily_update_inventory_kia_out"],
    x: 85, y: 1180, wires: [["daily_update_kia_authorized"]],
  },
  {
    id: "daily_update_kia_authorized", type: "switch", z: TAB, g: kiaUpdateGroup,
    name: "Janela de instalação autorizada?", property: "_update_apply_authorized", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 350, y: 1180, wires: [["daily_update_kia_auto_policy"], ["daily_update_kia_mode_audit"]],
  },
  {
    id: "daily_update_kia_auto_policy", type: "switch", z: TAB, g: kiaUpdateGroup,
    name: "PARÂMETRO Kia auto?", property: "update_policy.kia_uvo_auto_apply", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 630, y: 1140, wires: [["daily_update_kia_mode_install"], ["daily_update_kia_mode_audit"]],
  },
  {
    id: "daily_update_kia_mode_audit", type: "change", z: TAB, g: kiaUpdateGroup,
    name: "Modo: somente auditar", rules: [{ t: "set", p: "kia_update_mode", pt: "msg", to: "audit", tot: "str" }],
    action: "", property: "", from: "", to: "", reg: false, x: 870, y: 1220, wires: [["daily_update_kia_prepare"]],
  },
  {
    id: "daily_update_kia_mode_install", type: "change", z: TAB, g: kiaUpdateGroup,
    name: "Modo: promover e instalar", rules: [{ t: "set", p: "kia_update_mode", pt: "msg", to: "install", tot: "str" }],
    action: "", property: "", from: "", to: "", reg: false, x: 870, y: 1140, wires: [["daily_update_kia_prepare"]],
  },
  {
    id: "daily_update_kia_test_request", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "TESTE: solicitação bloqueada", props: [
      { p: "payload", v: '{"source":"manual_test","latest_version":"v3.13.0","test_mode":true}', vt: "json" },
      { p: "_kia_update_test", v: "true", vt: "bool" },
      { p: "kia_update_mode", v: "install", vt: "str" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 1300, wires: [["daily_update_kia_test_request_route_out"]],
  },
  {
    id: "daily_update_kia_test_request_route_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "TESTE Kia → preparação comum", mode: "link", links: ["daily_update_kia_test_request_route_in"],
    x: 480, y: 1300, wires: [],
  },
  {
    id: "daily_update_kia_test_request_route_in", type: "link in", z: TAB, g: kiaUpdateGroup,
    name: "Receber TESTE Kia na preparação", links: ["daily_update_kia_test_request_route_out"],
    x: 820, y: 1280, wires: [["daily_update_kia_prepare"]],
  },
  functionNode("daily_update_kia_prepare", kiaUpdateGroup, "Preparar alvo e modo exatos", prepareKiaUpdateCheck, 1, 1080, 1220, [["daily_update_kia_route_test"]]),
  {
    id: "daily_update_kia_route_test", type: "switch", z: TAB, g: kiaUpdateGroup,
    name: "Produção ou TESTE?", property: "_kia_update_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1280, y: 1220, wires: [["daily_update_kia_test_out"], ["daily_update_kia_request_host"]],
  },
  {
    id: "daily_update_kia_request_host", type: "exec", z: TAB, g: kiaUpdateGroup,
    command: "/opt/request-host-kia-uvo-update-check.sh", addpay: "payload", append: "", useSpawn: "false",
    timer: "30", winHide: false, oldrc: false, name: "Solicitar check ao host",
    x: 1020, y: 1220,
    wires: [["daily_update_kia_request_ack"], ["daily_update_kia_request_error"], ["daily_update_kia_request_complete"]],
  },
  functionNode("daily_update_kia_request_ack", kiaUpdateGroup, "Registrar solicitação Kia", recordKiaUpdateRequest, 0, 1290, 1140, []),
  functionNode("daily_update_kia_request_error", kiaUpdateGroup, "Falha segura da ponte Kia", recordExecError, 0, 1300, 1220, []),
  functionNode("daily_update_kia_request_complete", kiaUpdateGroup, "Código da ponte Kia", recordCompletion, 0, 1280, 1280, []),
  {
    id: "daily_update_kia_test_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "Solicitação Kia TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 885, y: 1180, wires: [],
  },
  {
    id: "daily_update_kia_result_startup", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "Ler resultado ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "50", topic: "", payload: "", payloadType: "date",
    x: 200, y: 1400, wires: [["daily_update_kia_read_result"]],
  },
  {
    id: "daily_update_kia_result_poll", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "Resultado a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 200, y: 1460, wires: [["daily_update_kia_read_result"]],
  },
  {
    id: "daily_update_kia_read_result", type: "exec", z: TAB, g: kiaUpdateGroup,
    command: "/opt/read-host-kia-uvo-update-result.sh", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado Kia seguro",
    x: 480, y: 1430,
    wires: [["daily_update_kia_parse_result"], ["daily_update_kia_read_error"], ["daily_update_kia_read_complete"]],
  },
  functionNode("daily_update_kia_read_error", kiaUpdateGroup, "Falha ao ler resultado Kia", recordExecError, 0, 810, 1480, []),
  functionNode("daily_update_kia_read_complete", kiaUpdateGroup, "Código da leitura Kia", recordCompletion, 0, 800, 1540, []),
  functionNode("daily_update_kia_parse_result", kiaUpdateGroup, "Normalizar e rotear instalação autorizada", parseKiaUpdateResult, 2, 830, 1420, [["daily_update_kia_result_test_out"], ["daily_update_kia_codex_request_out"]]),
  {
    id: "daily_update_kia_result_test_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "Resultado Kia TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1095, y: 1430, wires: [],
  },
  {
    id: "daily_update_kia_codex_request_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "Candidato autorizado → worker Codex", mode: "link", links: ["daily_update_kia_codex_request_in"],
    x: 1125, y: 1490, wires: [],
  },
  {
    id: "daily_update_kia_test_result", type: "inject", z: TAB, g: kiaUpdateGroup,
    name: "TESTE: conflito preservado", props: [
      { p: "payload", v: "kia-uvo-update status=conflict request_id=test mode=install installed_version=3.12.0 latest_version=v3.13.0 patch_state=conflict conflicts=1 checked_at=synthetic", vt: "str" },
      { p: "_kia_update_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 1570, wires: [["daily_update_kia_test_result_out"]],
  },
  {
    id: "daily_update_kia_test_result_out", type: "link out", z: TAB, g: kiaUpdateGroup,
    name: "Resultado Kia TESTE → parser", mode: "link", links: ["daily_update_kia_test_result_in"],
    x: 505, y: 1570, wires: [],
  },
  {
    id: "daily_update_kia_test_result_in", type: "link in", z: TAB, g: kiaUpdateGroup,
    name: "Receber resultado Kia TESTE", links: ["daily_update_kia_test_result_out"],
    x: 595, y: 1360, wires: [["daily_update_kia_parse_result"]],
  },
  {
    id: kiaCodexGroup, type: "group", z: TAB,
    name: "13. Candidato autorizado: Codex prepara; host aplica, valida e promove",
    style: { label: true, color: "#8f6bb3" },
    nodes: [
      "daily_update_kia_codex_architecture", "daily_update_kia_codex_request_in",
      "daily_update_kia_codex_request", "daily_update_kia_codex_ack",
      "daily_update_kia_codex_error", "daily_update_kia_codex_complete",
      "daily_update_kia_codex_result_startup", "daily_update_kia_codex_result_poll",
      "daily_update_kia_codex_read_result", "daily_update_kia_codex_read_error",
      "daily_update_kia_codex_read_complete", "daily_update_kia_codex_parse_result",
      "daily_update_kia_promotion_result_startup", "daily_update_kia_promotion_result_poll",
      "daily_update_kia_promotion_read_result", "daily_update_kia_promotion_read_error",
      "daily_update_kia_promotion_read_complete", "daily_update_kia_promotion_parse_result",
      "daily_update_kia_codex_test_result", "daily_update_kia_codex_test_result_out",
      "daily_update_kia_codex_test_result_in", "daily_update_kia_codex_result_test_out",
      "daily_update_kia_promotion_test_result", "daily_update_kia_promotion_test_result_out",
      "daily_update_kia_promotion_test_result_in", "daily_update_kia_promotion_result_test_out",
    ],
    x: 64, y: 1679, w: 1252, h: 832,
  },
  {
    id: "daily_update_kia_codex_architecture", type: "comment", z: TAB, g: kiaCodexGroup,
    name: "Codex isolado publica candidata; host valida runtime antes de promover main",
    info: "A candidata do Codex não equivale a uma atualização concluída. O host revalida a candidata, instala pelo HACS, confirma a integração ativa e só então envia main e remove a branch. O Codex não recebe Docker nem token HA. O teste sintético nunca alcança este grupo.",
    x: 660, y: 1720, wires: [],
  },
  {
    id: "daily_update_kia_codex_request_in", type: "link in", z: TAB, g: kiaCodexGroup,
    name: "Receber candidato autorizado", links: ["daily_update_kia_codex_request_out"],
    x: 145, y: 1820, wires: [["daily_update_kia_codex_request"]],
  },
  {
    id: "daily_update_kia_codex_request", type: "exec", z: TAB, g: kiaCodexGroup,
    command: "/opt/request-kia-uvo-codex-merge.sh", addpay: "payload", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Solicitar merge ao Codex",
    x: 500, y: 1820,
    wires: [["daily_update_kia_codex_ack"], ["daily_update_kia_codex_error"], ["daily_update_kia_codex_complete"]],
  },
  functionNode("daily_update_kia_codex_ack", kiaCodexGroup, "Registrar acionamento Codex", recordKiaCodexMergeRequest, 0, 840, 1780, []),
  functionNode("daily_update_kia_codex_error", kiaCodexGroup, "Falha segura da ponte Codex", recordExecError, 0, 850, 1840, []),
  functionNode("daily_update_kia_codex_complete", kiaCodexGroup, "Código da ponte Codex", recordCompletion, 0, 840, 1900, []),
  {
    id: "daily_update_kia_codex_result_startup", type: "inject", z: TAB, g: kiaCodexGroup,
    name: "Ler status Codex ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "65", topic: "", payload: "", payloadType: "date",
    x: 205, y: 1960, wires: [["daily_update_kia_codex_read_result"]],
  },
  {
    id: "daily_update_kia_codex_result_poll", type: "inject", z: TAB, g: kiaCodexGroup,
    name: "Status Codex a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 220, y: 2020, wires: [["daily_update_kia_codex_read_result"]],
  },
  {
    id: "daily_update_kia_codex_read_result", type: "exec", z: TAB, g: kiaCodexGroup,
    command: "/opt/read-kia-uvo-codex-merge-result.sh", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler status final do Codex",
    x: 500, y: 1990,
    wires: [["daily_update_kia_codex_parse_result"], ["daily_update_kia_codex_read_error"], ["daily_update_kia_codex_read_complete"]],
  },
  functionNode("daily_update_kia_codex_read_error", kiaCodexGroup, "Falha ao ler status Codex", recordExecError, 0, 800, 2050, []),
  functionNode("daily_update_kia_codex_read_complete", kiaCodexGroup, "Código da leitura Codex", recordCompletion, 0, 500, 2110, []),
  functionNode("daily_update_kia_codex_parse_result", kiaCodexGroup, "Normalizar falha final do Codex", parseKiaCodexMergeResult, 1, 810, 1990, [["daily_update_kia_codex_result_test_out"]]),
  {
    id: "daily_update_kia_codex_result_test_out", type: "link out", z: TAB, g: kiaCodexGroup,
    name: "Resultado Codex TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1105, y: 1990, wires: [],
  },
  {
    id: "daily_update_kia_codex_test_result", type: "inject", z: TAB, g: kiaCodexGroup,
    name: "TESTE: falha do worker Codex", props: [
      { p: "payload", v: "kia-uvo-codex-merge state=failed target=v3.12.0 updated_at=synthetic", vt: "str" },
      { p: "_kia_codex_merge_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 220, y: 2070, wires: [["daily_update_kia_codex_test_result_out"]],
  },
  {
    id: "daily_update_kia_codex_test_result_out", type: "link out", z: TAB, g: kiaCodexGroup,
    name: "Falha Codex TESTE → parser", mode: "link", links: ["daily_update_kia_codex_test_result_in"],
    x: 500, y: 2070, wires: [],
  },
  {
    id: "daily_update_kia_codex_test_result_in", type: "link in", z: TAB, g: kiaCodexGroup,
    name: "Receber falha Codex TESTE", links: ["daily_update_kia_codex_test_result_out"],
    x: 610, y: 2070, wires: [["daily_update_kia_codex_parse_result"]],
  },
  {
    id: "daily_update_kia_promotion_result_startup", type: "inject", z: TAB, g: kiaCodexGroup,
    name: "Ler promoção segura ao subir", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: true, onceDelay: "70", topic: "", payload: "", payloadType: "date",
    x: 215, y: 2170, wires: [["daily_update_kia_promotion_read_result"]],
  },
  {
    id: "daily_update_kia_promotion_result_poll", type: "inject", z: TAB, g: kiaCodexGroup,
    name: "Promoção segura a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 205, y: 2230, wires: [["daily_update_kia_promotion_read_result"]],
  },
  {
    id: "daily_update_kia_promotion_read_result", type: "exec", z: TAB, g: kiaCodexGroup,
    command: "/opt/read-kia-uvo-promotion-result.sh", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler promoção segura",
    x: 500, y: 2200,
    wires: [["daily_update_kia_promotion_parse_result"], ["daily_update_kia_promotion_read_error"], ["daily_update_kia_promotion_read_complete"]],
  },
  functionNode("daily_update_kia_promotion_read_error", kiaCodexGroup, "Falha ao ler promoção segura", recordExecError, 0, 800, 2260, []),
  functionNode("daily_update_kia_promotion_read_complete", kiaCodexGroup, "Código da promoção segura", recordCompletion, 0, 500, 2320, []),
  functionNode("daily_update_kia_promotion_parse_result", kiaCodexGroup, "Confirmar promoção segura", parseKiaPromotionResult, 1, 810, 2200, [["daily_update_kia_promotion_result_test_out"]]),
  {
    id: "daily_update_kia_promotion_result_test_out", type: "link out", z: TAB, g: kiaCodexGroup,
    name: "Promoção TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"],
    x: 1110, y: 2200, wires: [],
  },
  {
    id: "daily_update_kia_promotion_test_result", type: "inject", z: TAB, g: kiaCodexGroup,
    name: "TESTE: falha da promoção segura", props: [
      { p: "payload", v: "kia-uvo-promotion state=failed target=v3.12.0 updated_at=synthetic", vt: "str" },
      { p: "_kia_promotion_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "",
    payload: "", payloadType: "date", x: 215, y: 2410, wires: [["daily_update_kia_promotion_test_result_out"]],
  },
  {
    id: "daily_update_kia_promotion_test_result_out", type: "link out", z: TAB, g: kiaCodexGroup,
    name: "Falha promoção TESTE → parser", mode: "link", links: ["daily_update_kia_promotion_test_result_in"],
    x: 505, y: 2410, wires: [],
  },
  {
    id: "daily_update_kia_promotion_test_result_in", type: "link in", z: TAB, g: kiaCodexGroup,
    name: "Receber falha promoção TESTE", links: ["daily_update_kia_promotion_test_result_out"],
    x: 610, y: 2410, wires: [["daily_update_kia_promotion_parse_result"]],
  },
  {
    id: dependencyGroup, type: "group", z: TAB,
    name: "14. SUBFLUXO dependências do repositório: audit, política e atualização segura",
    style: { label: true, color: "#6d8f3f" },
    nodes: [
      "daily_update_dependency_architecture", "daily_update_dependency_chain_in",
      "daily_update_dependency_manual", "daily_update_dependency_test_source_in",
      "daily_update_dependency_policy", "daily_update_dependency_source",
      "daily_update_dependency_scan", "daily_update_dependency_scan_error",
      "daily_update_dependency_scan_complete", "daily_update_dependency_normalize",
      "daily_update_dependency_summary", "daily_update_dependency_summary_test_out", "daily_update_dependency_candidate_out",
      "daily_update_dependency_candidate_in", "daily_update_dependency_fix_gate",
      "daily_update_dependency_surface_gate", "daily_update_dependency_severity_gate",
      "daily_update_dependency_auto_gate", "daily_update_dependency_dedupe",
      "daily_update_dependency_prepare", "daily_update_dependency_final_gate",
      "daily_update_dependency_test_out", "daily_update_dependency_request",
      "daily_update_dependency_request_ack", "daily_update_dependency_request_error",
      "daily_update_dependency_request_complete", "daily_update_dependency_blocked",
      "daily_update_dependency_blocked_from_fix", "daily_update_dependency_blocked_from_surface",
      "daily_update_dependency_blocked_from_severity", "daily_update_dependency_blocked_from_auto",
      "daily_update_dependency_blocked_in", "daily_update_dependency_blocked_test_out", "daily_update_dependency_result_startup",
      "daily_update_dependency_result_poll", "daily_update_dependency_read_result",
      "daily_update_dependency_read_error", "daily_update_dependency_read_complete",
      "daily_update_dependency_test_result_in", "daily_update_dependency_parse_result",
      "daily_update_dependency_result_test_out", "daily_update_dependency_retry",
      "daily_update_dependency_retry_out", "daily_update_dependency_retry_in",
      "daily_update_dependency_test_reset_in",
      "daily_update_dependency_backup_out",
    ],
    x: 44, y: 5450, w: 2502, h: 722,
  },
  {
    id: "daily_update_dependency_architecture", type: "comment", z: TAB, g: dependencyGroup,
    name: "POLÍTICA: override exato + correção disponível + mesma major + qualquer severidade → aplicar",
    info: "O npm audit é apenas o produtor. Switches visuais autorizam somente overrides exatos com correção disponível. O worker mantém a mesma major, atualiza lock, revalida audit e flows, instala no runtime e reinicia somente o Node-RED com rollback. Sucesso solicita o backup Git canônico.",
    x: 970, y: 5490, wires: [],
  },
  {
    id: "daily_update_dependency_chain_in", type: "link in", z: TAB, g: dependencyGroup,
    name: "Receber sucesso dos containers", links: ["daily_update_dependency_chain_out"],
    x: 85, y: 5570, wires: [["daily_update_dependency_policy"]],
  },
  {
    id: "daily_update_dependency_manual", type: "inject", z: TAB, g: dependencyGroup,
    name: "Verificar dependências agora", props: [{ p: "payload" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 220, y: 5630, wires: [["daily_update_dependency_policy"]],
  },
  {
    id: "daily_update_dependency_test_source_in", type: "link in", z: TAB, g: dependencyGroup,
    name: "Receber audit TESTE", links: ["daily_update_dependency_test_source_out"],
    x: 85, y: 5690, wires: [["daily_update_dependency_policy"]],
  },
  {
    id: "daily_update_dependency_policy", type: "change", z: TAB, g: dependencyGroup,
    name: "PARÂMETROS: override, mesma major, auto", rules: [{ t: "set", p: "dependency_policy", pt: "msg", to: '{"version":1,"managed_surface":"override","same_major_only":true,"auto_apply":true,"severities":["low","moderate","high","critical"]}', tot: "json" }],
    action: "", property: "", from: "", to: "", reg: false, x: 500, y: 5600,
    wires: [["daily_update_dependency_source"]],
  },
  {
    id: "daily_update_dependency_source", type: "switch", z: TAB, g: dependencyGroup,
    name: "Audit real ou TESTE?", property: "_repository_dependency_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 780, y: 5600, wires: [["daily_update_dependency_normalize"], ["daily_update_dependency_scan"]],
  },
  {
    id: "daily_update_dependency_scan", type: "exec", z: TAB, g: dependencyGroup,
    command: "node /data/tools/scan-repository-dependency-audit.mjs", addpay: "", append: "", useSpawn: "false",
    timer: "90", winHide: false, oldrc: false, name: "Produzir npm audit sanitizado", x: 1060, y: 5590,
    wires: [["daily_update_dependency_normalize"], ["daily_update_dependency_scan_error"], ["daily_update_dependency_scan_complete"]],
  },
  functionNode("daily_update_dependency_scan_error", dependencyGroup, "Falha do produtor audit", recordExecError, 0, 1350, 5500, []),
  functionNode("daily_update_dependency_scan_complete", dependencyGroup, "Código do npm audit", `const code=Number(msg.payload?.code ?? msg.payload ?? -1); if (![0,1].includes(code)) node.status({fill:"red",shape:"ring",text:"audit código "+code}); return null;`, 0, 1350, 5610, []),
  functionNode("daily_update_dependency_normalize", dependencyGroup, "Normalizar contrato do audit", normalizeRepositoryDependencyAudit, 2, 1250, 5690, [["daily_update_dependency_candidate_out"], ["daily_update_dependency_summary"]]),
  functionNode("daily_update_dependency_summary", dependencyGroup, "Registrar inventário npm", `const summary=msg.payload; node.status({fill:summary.candidate_count?"yellow":"green",shape:"dot",text:summary.candidate_count+" candidato(s)"}); return summary.test_mode ? msg : null;`, 1, 1540, 5550, [["daily_update_dependency_summary_test_out"]]),
  {
    id: "daily_update_dependency_summary_test_out", type: "link out", z: TAB, g: dependencyGroup,
    name: "Resumo TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1810, y: 5550, wires: [],
  },
  {
    id: "daily_update_dependency_candidate_out", type: "link out", z: TAB, g: dependencyGroup,
    name: "Candidatos → política", mode: "link", links: ["daily_update_dependency_candidate_in"], x: 1510, y: 5690, wires: [],
  },
  {
    id: "daily_update_dependency_candidate_in", type: "link in", z: TAB, g: dependencyGroup,
    name: "Receber candidatos", links: ["daily_update_dependency_candidate_out"], x: 85, y: 5790,
    wires: [["daily_update_dependency_fix_gate"]],
  },
  {
    id: "daily_update_dependency_fix_gate", type: "switch", z: TAB, g: dependencyGroup,
    name: "Correção disponível?", property: "payload.fix_available", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 220, y: 5790, wires: [["daily_update_dependency_surface_gate"], ["daily_update_dependency_blocked_from_fix"]],
  },
  {
    id: "daily_update_dependency_surface_gate", type: "switch", z: TAB, g: dependencyGroup,
    name: "É override gerenciado?", property: "payload.managed_surface", propertyType: "msg",
    rules: [{ t: "eq", v: "override", vt: "str" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 480, y: 5790, wires: [["daily_update_dependency_severity_gate"], ["daily_update_dependency_blocked_from_surface"]],
  },
  {
    id: "daily_update_dependency_severity_gate", type: "switch", z: TAB, g: dependencyGroup,
    name: "Severidade reconhecida?", property: "payload.severity", propertyType: "msg",
    rules: [{ t: "regex", v: "^(low|moderate|high|critical)$", vt: "str", case: false }, { t: "else" }],
    checkall: "true", repair: false, outputs: 2, x: 760, y: 5790,
    wires: [["daily_update_dependency_auto_gate"], ["daily_update_dependency_blocked_from_severity"]],
  },
  {
    id: "daily_update_dependency_auto_gate", type: "switch", z: TAB, g: dependencyGroup,
    name: "Auto apply habilitado?", property: "dependency_policy.auto_apply", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1040, y: 5790, wires: [["daily_update_dependency_dedupe"], ["daily_update_dependency_blocked_from_auto"]],
  },
  {
    id: "daily_update_dependency_dedupe", type: "rbe", z: TAB, g: dependencyGroup,
    name: "Deduplicar candidato", func: "rbe", gap: "", start: "", inout: "out", septopics: false,
    property: "payload.signature", topi: "topic", x: 1290, y: 5790,
    wires: [["daily_update_dependency_prepare"]],
  },
  functionNode("daily_update_dependency_prepare", dependencyGroup, "Preparar pacote", prepareRepositoryDependencyRequest, 1, 1510, 5790, [["daily_update_dependency_final_gate"]]),
  {
    id: "daily_update_dependency_final_gate", type: "switch", z: TAB, g: dependencyGroup,
    name: "GATE FINAL: produção ou TESTE?", property: "_repository_dependency_test", propertyType: "msg",
    rules: [{ t: "true" }, { t: "else" }], checkall: "true", repair: false, outputs: 2,
    x: 1770, y: 5790, wires: [["daily_update_dependency_test_out"], ["daily_update_dependency_request"]],
  },
  {
    id: "daily_update_dependency_test_out", type: "link out", z: TAB, g: dependencyGroup,
    name: "Atualização TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 2055, y: 5750, wires: [],
  },
  {
    id: "daily_update_dependency_request", type: "exec", z: TAB, g: dependencyGroup,
    command: "/opt/request-host-repository-dependency-update.sh", addpay: "payload", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Solicitar atualização ao host", x: 2040, y: 5830,
    wires: [["daily_update_dependency_request_ack"], ["daily_update_dependency_request_error"], ["daily_update_dependency_request_complete"]],
  },
  functionNode("daily_update_dependency_request_ack", dependencyGroup, "Registrar solicitação npm", recordRepositoryDependencyRequest, 0, 2360, 5790, []),
  functionNode("daily_update_dependency_request_error", dependencyGroup, "Falha segura da ponte npm", recordExecError, 0, 2360, 5850, []),
  functionNode("daily_update_dependency_request_complete", dependencyGroup, "Código da ponte npm", recordCompletion, 0, 2360, 5910, []),
  {
    id: "daily_update_dependency_blocked_from_fix", type: "link out", z: TAB, g: dependencyGroup,
    name: "Sem correção → bloqueio", mode: "link", links: ["daily_update_dependency_blocked_in"], x: 390, y: 5850, wires: [],
  },
  {
    id: "daily_update_dependency_blocked_from_surface", type: "link out", z: TAB, g: dependencyGroup,
    name: "Fora do override → bloqueio", mode: "link", links: ["daily_update_dependency_blocked_in"], x: 660, y: 5850, wires: [],
  },
  {
    id: "daily_update_dependency_blocked_from_severity", type: "link out", z: TAB, g: dependencyGroup,
    name: "Severidade inválida → bloqueio", mode: "link", links: ["daily_update_dependency_blocked_in"], x: 930, y: 5850, wires: [],
  },
  {
    id: "daily_update_dependency_blocked_from_auto", type: "link out", z: TAB, g: dependencyGroup,
    name: "Auto desligado → bloqueio", mode: "link", links: ["daily_update_dependency_blocked_in"], x: 1190, y: 5850, wires: [],
  },
  {
    id: "daily_update_dependency_blocked_in", type: "link in", z: TAB, g: dependencyGroup,
    name: "Receber bloqueio da política", links: [
      "daily_update_dependency_blocked_from_fix", "daily_update_dependency_blocked_from_surface",
      "daily_update_dependency_blocked_from_severity", "daily_update_dependency_blocked_from_auto",
    ], x: 850, y: 5910, wires: [["daily_update_dependency_blocked"]],
  },
  functionNode("daily_update_dependency_blocked", dependencyGroup, "Bloquear candidato fora da política", recordRepositoryDependencyBlocked, 1, 1080, 5910, [["daily_update_dependency_blocked_test_out"]]),
  {
    id: "daily_update_dependency_blocked_test_out", type: "link out", z: TAB, g: dependencyGroup,
    name: "Bloqueio TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1295, y: 5870, wires: [],
  },
  {
    id: "daily_update_dependency_result_startup", type: "inject", z: TAB, g: dependencyGroup,
    name: "Ler resultado ao subir", props: [{ p: "payload" }], repeat: "", crontab: "", once: true, onceDelay: "45",
    topic: "", payload: "", payloadType: "date", x: 210, y: 5990, wires: [["daily_update_dependency_read_result"]],
  },
  {
    id: "daily_update_dependency_result_poll", type: "inject", z: TAB, g: dependencyGroup,
    name: "Resultado a cada 1 min", props: [{ p: "payload" }], repeat: "60", crontab: "", once: false, onceDelay: 0.1,
    topic: "", payload: "", payloadType: "date", x: 220, y: 6050, wires: [["daily_update_dependency_read_result"]],
  },
  {
    id: "daily_update_dependency_read_result", type: "exec", z: TAB, g: dependencyGroup,
    command: "/opt/read-host-repository-dependency-update-result.sh", addpay: "", append: "", useSpawn: "false",
    timer: "15", winHide: false, oldrc: false, name: "Ler resultado npm seguro", x: 510, y: 6020,
    wires: [["daily_update_dependency_parse_result"], ["daily_update_dependency_read_error"], ["daily_update_dependency_read_complete"]],
  },
  functionNode("daily_update_dependency_read_error", dependencyGroup, "Falha ao ler resultado npm", recordExecError, 0, 750, 6100, []),
  functionNode("daily_update_dependency_read_complete", dependencyGroup, "Código da leitura npm", recordCompletion, 0, 970, 6100, []),
  {
    id: "daily_update_dependency_test_result_in", type: "link in", z: TAB, g: dependencyGroup,
    name: "Receber resultado npm TESTE", links: ["daily_update_dependency_test_result_out"],
    x: 820, y: 5940, wires: [["daily_update_dependency_parse_result"]],
  },
  functionNode("daily_update_dependency_parse_result", dependencyGroup, "Normalizar resultado npm", parseRepositoryDependencyResult, 3, 1000, 6020, [["daily_update_dependency_result_test_out"], ["daily_update_dependency_backup_out"], ["daily_update_dependency_retry"]]),
  {
    id: "daily_update_dependency_result_test_out", type: "link out", z: TAB, g: dependencyGroup,
    name: "Resultado npm TESTE → dry-run", mode: "link", links: ["daily_update_dry_run_in"], x: 1260, y: 5980, wires: [],
  },
  {
    id: "daily_update_dependency_retry", type: "delay", z: TAB, g: dependencyGroup,
    name: "Reconsultar após deferimento", pauseType: "delay", timeout: "75", timeoutUnits: "seconds",
    rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1", randomLast: "5", randomUnits: "seconds",
    drop: false, allowrate: false, outputs: 1, x: 1320, y: 6070, wires: [["daily_update_dependency_retry_out"]],
  },
  {
    id: "daily_update_dependency_retry_out", type: "link out", z: TAB, g: dependencyGroup,
    name: "Retry → releitura", mode: "link", links: ["daily_update_dependency_retry_in"], x: 1530, y: 6070, wires: [],
  },
  {
    id: "daily_update_dependency_retry_in", type: "link in", z: TAB, g: dependencyGroup,
    name: "Receber retry", links: ["daily_update_dependency_retry_out"], x: 305, y: 6140,
    wires: [["daily_update_dependency_read_result"]],
  },
  {
    id: "daily_update_dependency_test_reset_in", type: "link in", z: TAB, g: dependencyGroup,
    name: "Receber reset TESTE", links: ["daily_update_dependency_test_reset_out"], x: 1130, y: 5730,
    wires: [["daily_update_dependency_dedupe"]],
  },
  {
    id: "daily_update_dependency_backup_out", type: "link out", z: TAB, g: dependencyGroup,
    name: "Atualização concluída → backup Git", mode: "link", links: ["git_backup_request_in"], x: 1420, y: 5980, wires: [],
  },
  {
    id: dependencyTestGroup, type: "group", z: TAB,
    name: "15. TESTES da atualização de dependências: caminho completo sem npm, restart ou push",
    style: { label: true, color: "#7d6ba8" },
    nodes: [
      "daily_update_dependency_test_instructions", "daily_update_dependency_test_reset",
      "daily_update_dependency_test_reset_out",
      "daily_update_dependency_test_safe", "daily_update_dependency_test_blocked",
      "daily_update_dependency_test_source_out", "daily_update_dependency_test_result",
      "daily_update_dependency_test_result_out",
    ],
    x: 44, y: 6210, w: 1392, h: 302,
  },
  {
    id: "daily_update_dependency_test_instructions", type: "comment", z: TAB, g: dependencyTestGroup,
    name: "TESTE: 1) reset 2) elegível ou transitive bloqueado 3) resultado; confira o terminal dry-run",
    info: "Os candidatos sintéticos atravessam normalização, política, dedupe e gate final. Nenhum npm install, restart ou push é executado.",
    x: 670, y: 6250, wires: [],
  },
  {
    id: "daily_update_dependency_test_reset", type: "inject", z: TAB, g: dependencyTestGroup,
    name: "TESTE 1: reset do dedupe", props: [{ p: "reset", v: "true", vt: "bool" }], repeat: "", crontab: "",
    once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date", x: 220, y: 6330,
    wires: [["daily_update_dependency_test_reset_out"]],
  },
  {
    id: "daily_update_dependency_test_reset_out", type: "link out", z: TAB, g: dependencyTestGroup,
    name: "Reset TESTE → dedupe", mode: "link", links: ["daily_update_dependency_test_reset_in"], x: 490, y: 6330, wires: [],
  },
  {
    id: "daily_update_dependency_test_safe", type: "inject", z: TAB, g: dependencyTestGroup,
    name: "TESTE 2A: override elegível", props: [
      { p: "payload", v: '{"version":1,"status":"ok","candidates":[{"package":"joi","severity":"low","current_version":"17.13.4","declared_version":"17.13.4","managed_surface":"override","fix_available":true,"signature":"joi:test:eligible"}]}', vt: "json" },
      { p: "_repository_dependency_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 230, y: 6390, wires: [["daily_update_dependency_test_source_out"]],
  },
  {
    id: "daily_update_dependency_test_blocked", type: "inject", z: TAB, g: dependencyTestGroup,
    name: "TESTE 2B: transitive bloqueado", props: [
      { p: "payload", v: '{"version":1,"status":"ok","candidates":[{"package":"indireta","severity":"high","current_version":"1.0.0","declared_version":null,"managed_surface":"transitive","fix_available":true,"signature":"indireta:test:blocked"}]}', vt: "json" },
      { p: "_repository_dependency_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 240, y: 6450, wires: [["daily_update_dependency_test_source_out"]],
  },
  {
    id: "daily_update_dependency_test_source_out", type: "link out", z: TAB, g: dependencyTestGroup,
    name: "Audit TESTE → subfluxo", mode: "link", links: ["daily_update_dependency_test_source_in"], x: 540, y: 6420, wires: [],
  },
  {
    id: "daily_update_dependency_test_result", type: "inject", z: TAB, g: dependencyTestGroup,
    name: "TESTE 3: resultado concluído", props: [
      { p: "payload", v: "repository-dependency-update package=joi status=success request_id=test from=17.13.4 to=17.13.6", vt: "str" },
      { p: "_repository_dependency_test", v: "true", vt: "bool" },
    ], repeat: "", crontab: "", once: false, onceDelay: 0.1, topic: "", payload: "", payloadType: "date",
    x: 850, y: 6390, wires: [["daily_update_dependency_test_result_out"]],
  },
  {
    id: "daily_update_dependency_test_result_out", type: "link out", z: TAB, g: dependencyTestGroup,
    name: "Resultado TESTE → parser", mode: "link", links: ["daily_update_dependency_test_result_in"], x: 1150, y: 6390, wires: [],
  },
];

// Keep the original approved groups intact while opening space for the four
// host stages and for the centralized update.* inventory.
const verticalShifts = new Map([
  [testGroup, 1520],
  [inventoryGroup, 620],
  [hacsGroup, 820],
  [unknownGroup, 820],
  [alexaGroup, 620],
  [firmwareGroup, 1440],
  [kiaUpdateGroup, 4120],
  [kiaCodexGroup, 4120],
  [dependencyGroup, 1220],
  [dependencyTestGroup, 1220],
]);
const inventoryDecisionIds = new Set([
  "daily_update_inventory_test_snapshot_out", "daily_update_inventory_snapshot_in",
  "daily_update_inventory_normalize", "daily_update_inventory_state", "daily_update_inventory_classify",
  "daily_update_inventory_record", "daily_update_inventory_unavailable", "daily_update_inventory_current",
  "daily_update_inventory_summary_test_out", "daily_update_inventory_nonpending_test_out",
  "daily_update_inventory_kia_out", "daily_update_inventory_firmware_out", "daily_update_inventory_core_out",
  "daily_update_inventory_alexa_out", "daily_update_inventory_hacs_out", "daily_update_inventory_unknown_out",
]);
for (const node of nodes) {
  const shift = (verticalShifts.get(node.id) ?? verticalShifts.get(node.g) ?? 0) +
    (inventoryDecisionIds.has(node.id) ? 180 : 0);
  if (shift && Number.isFinite(node.y)) node.y += shift;
}

// Preserve the manually approved canvas placement after the repository-wide
// 64 px left-margin normalization shifted this tab as a single unit.
for (const node of nodes) {
  if (node.z === TAB && Number.isFinite(node.x)) node.x += 20;
}

const replacements = new Map(nodes.map((node) => [node.id, node]));
const liveOwnedIds = new Set(replacements.keys());
const keepReference = (id) => !owned(id) || liveOwnedIds.has(id);
const next = [];
let lastOwnedPosition = -1;
for (const existing of flows) {
  if (owned(existing.id)) {
    const replacement = replacements.get(existing.id);
    if (replacement) {
      next.push(replacement);
      replacements.delete(existing.id);
      lastOwnedPosition = next.length;
    }
    continue;
  }
  if (Array.isArray(existing.nodes)) existing.nodes = existing.nodes.filter(keepReference);
  if (Array.isArray(existing.scope)) existing.scope = existing.scope.filter(keepReference);
  if (Array.isArray(existing.wires)) existing.wires = existing.wires.map((wire) => Array.isArray(wire) ? wire.filter(keepReference) : wire);
  if (Array.isArray(existing.links)) existing.links = existing.links.filter(keepReference);
  next.push(existing);
}
if (replacements.size) {
  const firstConfig = next.findIndex((node) => node.z === undefined && !["tab", "subflow"].includes(node.type));
  const insertion = lastOwnedPosition >= 0
    ? lastOwnedPosition
    : firstConfig === -1 ? next.length : firstConfig;
  next.splice(insertion, 0, ...replacements.values());
}
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Installed ${nodes.length} daily host update nodes in ${outputPath}`);
