// Latest intent only. Business decisions are made downstream again on release.
const test = msg._startup_test === true;
const suffix = test ? "__test" : "";
const now = Number(msg.startup_now ?? os.uptime() * 1000);
if (msg._startup_tick !== true) {
    const revision = Number(flow.get("startup_sequence" + suffix, "memoryOnly") || 0) + 1;
    flow.set("startup_sequence" + suffix, revision, "memoryOnly");
    flow.set("startup_pending" + suffix, { message: msg, created_at: now, revision }, "memoryOnly");
}
const pending = flow.get("startup_pending" + suffix, "memoryOnly");
const ready = test ? flow.get("startup_test_readiness", "memoryOnly") : global.get("startup_readiness_v1", "memoryOnly");
const policy = global.get("startup_policy_v1", "memoryOnly");
msg = { _startup_test: test, startup_now: now, pending, readiness: ready, policy,
    startup_order: Number(env.get("STARTUP_ORDER") || 0) };
return msg;
