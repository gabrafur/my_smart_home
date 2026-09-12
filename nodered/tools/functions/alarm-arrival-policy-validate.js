const p = msg.payload ?? {};
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
msg.policy_candidate = {
    cooldown_s: Number(p.cooldown_s), confirmation_ttl_s: Number(p.confirmation_ttl_s),
    delivery_window_s: Number(p.delivery_window_s), test_ttl_s: Number(p.test_ttl_s)
};
msg.policy_valid = integer(msg.policy_candidate.cooldown_s, 0, 600) &&
    integer(msg.policy_candidate.confirmation_ttl_s, 30, 900) &&
    integer(msg.policy_candidate.delivery_window_s, 5, 120) &&
    integer(msg.policy_candidate.test_ttl_s, 30, 600);
return msg;
