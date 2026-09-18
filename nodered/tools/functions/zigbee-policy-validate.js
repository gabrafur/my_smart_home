const candidate = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const failure = Number(candidate.failure_confirmation_s);
const recovery = Number(candidate.recovery_confirmation_s);
const reminder = Number(candidate.reminder_interval_h);
const routeCooldown = Number(candidate.route_recovery_cooldown_min);
const routeAttempts = Number(candidate.route_recovery_max_attempts);
const errors = [];
if (!Number.isInteger(failure) || failure < 1 || failure > 300) errors.push("failure_confirmation_s");
if (!Number.isInteger(recovery) || recovery < 1 || recovery > 600) errors.push("recovery_confirmation_s");
if (!Number.isInteger(reminder) || reminder < 1 || reminder > 168) errors.push("reminder_interval_h");
if (!Number.isInteger(routeCooldown) || routeCooldown < 1 || routeCooldown > 1440) errors.push("route_recovery_cooldown_min");
if (!Number.isInteger(routeAttempts) || routeAttempts < 1 || routeAttempts > 5) errors.push("route_recovery_max_attempts");
msg.policy_valid = errors.length === 0;
msg.policy_error = errors.join(",");
msg.policy_candidate = msg.policy_valid ? {
    version: 2,
    failure_confirmation_s: failure,
    recovery_confirmation_s: recovery,
    reminder_interval_h: reminder,
    route_recovery_cooldown_min: routeCooldown,
    route_recovery_max_attempts: routeAttempts
} : null;
return msg;
