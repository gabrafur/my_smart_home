const current = msg.zigbee_route_current;
const test = msg._zigbee_test === true;
const suffix = test ? "__test" : "";
const store = test ? undefined : "memoryOnly";
const live = flow.get("zigbee_route_live" + suffix, store) || {};
const boot = flow.get("zigbee_boot_at" + suffix, store);
const evidence = live[current.device];
const configured = Date.parse(current.verification_started_at || "");
const started = Number.isFinite(configured) ? configured : evidence?.first_seen;
const failure = Date.parse(current.last_failure_at || "");
const bridge = flow.get("zigbee_bridge_observation" + suffix, store);
const windowStart = Math.max(started || 0, failure || 0, boot || 0, bridge?.changed_at || 0);
msg.zigbee_route_verification_started = Number.isFinite(started);
msg.zigbee_route_verification_age_ms = Number.isFinite(started)
    ? msg.zigbee_route_now - windowStart : -1;
msg.zigbee_route_live_after_window = Number.isFinite(started) &&
    evidence?.failure_at === current.last_failure_at &&
    Number(evidence?.last_seen || 0) >= windowStart + msg.policy.route_stability_s * 1000;
return msg;
