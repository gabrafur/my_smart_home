const p = msg.payload ?? {};
const n = (key) => Number(p[key]);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
msg.policy_candidate = {
    warning_pct: n("warning_pct"), high_pct: n("high_pct"), critical_pct: n("critical_pct"),
    hysteresis_pp: n("hysteresis_pp"), notification_cooldown_h: n("notification_cooldown_h"),
    command_error_cooldown_h: n("command_error_cooldown_h"), trend_24h_pp: n("trend_24h_pp"),
    trend_7d_pp: n("trend_7d_pp"), auto_remediation_cooldown_h: n("auto_remediation_cooldown_h"),
    sample_interval_min: n("sample_interval_min"), history_retention_days: n("history_retention_days")
};
const c = msg.policy_candidate;
msg.policy_valid = integer(c.warning_pct, 1, 98) && integer(c.high_pct, 2, 99) && integer(c.critical_pct, 3, 100) &&
    c.warning_pct < c.high_pct && c.high_pct < c.critical_pct && integer(c.hysteresis_pp, 0, 20) &&
    integer(c.notification_cooldown_h, 1, 48) && integer(c.command_error_cooldown_h, 1, 48) &&
    integer(c.trend_24h_pp, 1, 50) && integer(c.trend_7d_pp, 1, 80) && integer(c.auto_remediation_cooldown_h, 1, 48) &&
    integer(c.sample_interval_min, 1, 120) && integer(c.history_retention_days, 2, 30);
return msg;
