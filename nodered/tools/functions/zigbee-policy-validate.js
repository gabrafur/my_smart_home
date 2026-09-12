const candidate = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const failure = Number(candidate.failure_confirmation_s);
const recovery = Number(candidate.recovery_confirmation_s);
const reminder = Number(candidate.reminder_interval_h);
const errors = [];
if (!Number.isInteger(failure) || failure < 1 || failure > 300) errors.push("failure_confirmation_s");
if (!Number.isInteger(recovery) || recovery < 1 || recovery > 600) errors.push("recovery_confirmation_s");
if (!Number.isInteger(reminder) || reminder < 1 || reminder > 168) errors.push("reminder_interval_h");
msg.policy_valid = errors.length === 0;
msg.policy_error = errors.join(",");
msg.policy_candidate = msg.policy_valid ? {
    version: 1,
    failure_confirmation_s: failure,
    recovery_confirmation_s: recovery,
    reminder_interval_h: reminder
} : null;
return msg;
