const p = msg.payload ?? {};
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
msg.policy_candidate = {
    failure_confirm_s: Number(p.failure_confirm_s),
    recovery_confirm_s: Number(p.recovery_confirm_s),
    report_stale_s: Number(p.report_stale_s),
    reminder_s: Number(p.reminder_s)
};
msg.policy_valid =
    integer(msg.policy_candidate.failure_confirm_s, 1, 600) &&
    integer(msg.policy_candidate.recovery_confirm_s, 1, 300) &&
    integer(msg.policy_candidate.report_stale_s, 30, 900) &&
    integer(msg.policy_candidate.reminder_s, 300, 172800);
return msg;
