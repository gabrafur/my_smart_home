const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const targets = Array.isArray(input.targets) ? input.targets : [];
const number = (key) => Number(input[key]);
const values = {
    required_responses: number("required_responses"),
    failure_cycles: number("failure_cycles"),
    recovery_cycles: number("recovery_cycles"),
    ping_timeout_s: number("ping_timeout_s"),
    exec_timeout_ms: number("exec_timeout_ms"),
    remote_access_failure_cycles: number("remote_access_failure_cycles"),
    remote_access_report_stale_s: number("remote_access_report_stale_s"),
    remote_access_recovery_cooldown_s: number("remote_access_recovery_cooldown_s")
};
const ranges = {
    required_responses: [1, targets.length],
    failure_cycles: [1, 10],
    recovery_cycles: [1, 10],
    ping_timeout_s: [1, 10],
    exec_timeout_ms: [1000, 15000],
    remote_access_failure_cycles: [1, 5],
    remote_access_report_stale_s: [30, 900],
    remote_access_recovery_cooldown_s: [60, 3600]
};
const errors = [];
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
if (targets.length !== 3 || targets.some((target) =>
    !target || typeof target.name !== "string" || !ipv4.test(String(target.address ?? "")))) {
    errors.push("targets");
}
if (new Set(targets.map((target) => target.address)).size !== targets.length) errors.push("targets_unique");
for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    if (!Number.isInteger(values[key]) || values[key] < minimum || values[key] > maximum) errors.push(key);
}
if (values.exec_timeout_ms <= values.ping_timeout_s * 1000) errors.push("exec_timeout_ms");
msg.policy_valid = errors.length === 0;
msg.policy_error = errors.join(",");
msg.policy_candidate = msg.policy_valid ? {
    version: 1,
    targets: targets.map(({ name, address }) => ({ name, address })),
    ...values
} : null;
return msg;
