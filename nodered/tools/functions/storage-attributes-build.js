const s = msg.storage;
const input = s.input;
msg.storage_attributes = {
    used_percent: s.used,
    used_gib: Number.isFinite(Number(input.used_gb)) ? Number(input.used_gb) : null,
    free_gib: s.free,
    filesystem: input.filesystem ?? "/",
    inode_used_percent: Number.isFinite(Number(input.inode_used_percent)) ? Number(input.inode_used_percent) : null,
    growth_24h_percentage_points: s.growth24h,
    growth_7d_percentage_points: s.growth7d,
    history_samples: s.history_samples,
    history_coverage_hours: s.history_coverage_hours,
    history_oldest_at: s.history_oldest_at,
    growth_cause: s.growth_cause,
    growth_cause_bytes: s.growth_cause_bytes,
    category_growth_24h_bytes: s.category_growth,
    collected_at: input.collected_at ?? new Date(s.now).toISOString(),
    thresholds: { warning: msg.policy.warning_pct, high: msg.policy.high_pct, critical: msg.policy.critical_pct },
    hysteresis_percentage_points: msg.policy.hysteresis_pp
};
return msg;
