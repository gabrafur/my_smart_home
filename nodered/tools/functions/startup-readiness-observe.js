const test = msg._startup_test === true;
const key = "startup_observations_v1" + (test ? "__test" : "");
const state = flow.get(key, "memoryOnly") || {};
const now = Number(msg.startup_now ?? os.uptime() * 1000);
if (msg.status) {
    // Any broker status transition invalidates previous connection evidence.
    flow.set(key, {}, "memoryOnly");
} else if (msg.retain !== true && ["internet", "vpn"].includes(msg.startup_source)) {
    state[msg.startup_source] = { state: String(msg.payload), received_at: now };
    flow.set(key, state, "memoryOnly");
}
return msg;
