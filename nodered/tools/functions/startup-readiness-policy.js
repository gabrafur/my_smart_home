const p = msg.payload;
const limits = { boot_grace_s: [30, 900], connection_stable_s: [30, 600], source_fresh_s: [60, 600], release_spacing_s: [1, 60], pending_ttl_s: [60, 3600] };
msg.policy_valid = !!p && Object.entries(limits).every(([key, [min, max]]) => Number.isInteger(p[key]) && p[key] >= min && p[key] <= max);
if (msg.policy_valid) msg.policy_candidate = { version: 1, ...Object.fromEntries(Object.keys(limits).map(k => [k, p[k]])) };
return msg;
