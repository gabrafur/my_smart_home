const test = msg._startup_test === true;
const suffix = test ? "__test" : "";
const now = Number(msg.startup_now ?? os.uptime() * 1000);
const policy = flow.get("startup_policy_v1", "persistent");
if (!policy) return null;
const observations = flow.get("startup_observations_v1" + suffix, "memoryOnly") || {};
const previous = flow.get("startup_lifecycle_v1" + suffix, "memoryOnly") || { boot_at: now, stable_since: null };
const facts = { now, test_mode: test, suffix, policy, previous, boot_age_ms: now - previous.boot_at };
for (const source of ["internet", "vpn"]) {
    const value = observations[source];
    facts[source + "_state"] = value && now >= value.received_at && now - value.received_at <= policy.source_fresh_s * 1000
        ? value.state : "unknown";
}
facts.stable_age_ms = previous.stable_since === null ? 0 : Math.max(0, now - previous.stable_since);
msg.startup = facts;
return msg;
