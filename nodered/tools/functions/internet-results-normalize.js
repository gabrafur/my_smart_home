const results = Array.isArray(msg.payload?.results) ? msg.payload.results : [];
msg.internet_results = results.filter((result) => result && typeof result === "object").map((result) => ({
    name: String(result.name ?? "unknown"),
    address: String(result.address ?? "unknown"),
    ok: result.ok === true
}));
msg.internet_targets_total = msg.internet_results.length;
msg.internet_targets_ok = msg.internet_results.filter((result) => result.ok).length;
msg.internet_checked_at = typeof msg.payload?.checked_at === "string"
    ? msg.payload.checked_at
    : new Date(Number(msg.monitor_now ?? Date.now())).toISOString();
return msg;
