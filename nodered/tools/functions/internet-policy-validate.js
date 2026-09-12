const candidate = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const targets = Array.isArray(candidate.targets) ? candidate.targets : [];
const required = Number(candidate.required_responses);
const failures = Number(candidate.failure_cycles);
const recoveries = Number(candidate.recovery_cycles);
const pingTimeout = Number(candidate.ping_timeout_s);
const execTimeout = Number(candidate.exec_timeout_ms);
const errors = [];
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

if (targets.length !== 3 || targets.some((target) =>
    !target || typeof target.name !== "string" || !ipv4.test(String(target.address ?? ""))
)) errors.push("targets");
if (new Set(targets.map((target) => target.address)).size !== targets.length) errors.push("targets_unique");
if (!Number.isInteger(required) || required < 1 || required > targets.length) errors.push("required_responses");
if (!Number.isInteger(failures) || failures < 1 || failures > 10) errors.push("failure_cycles");
if (!Number.isInteger(recoveries) || recoveries < 1 || recoveries > 10) errors.push("recovery_cycles");
if (!Number.isInteger(pingTimeout) || pingTimeout < 1 || pingTimeout > 10) errors.push("ping_timeout_s");
if (!Number.isInteger(execTimeout) || execTimeout < 1000 || execTimeout > 15000 || execTimeout <= pingTimeout * 1000) errors.push("exec_timeout_ms");

msg.policy_valid = errors.length === 0;
msg.policy_error = errors.join(",");
msg.policy_candidate = msg.policy_valid ? {
    version: 1,
    targets: targets.map((target) => ({ name: target.name, address: target.address })),
    required_responses: required,
    failure_cycles: failures,
    recovery_cycles: recoveries,
    ping_timeout_s: pingTimeout,
    exec_timeout_ms: execTimeout
} : null;
return msg;
