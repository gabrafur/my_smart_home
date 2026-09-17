const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const testMode = msg._host_memory_guardian_test === true || result.test_mode === true;
const forceStale = testMode && msg._host_memory_guardian_force_stale === true;
const maximumAgeSeconds = Number(msg.guardian_max_age_seconds);
const checkedAt = Date.parse(String(result.checked_at ?? ""));
const ageMs = Date.now() - checkedAt;
msg.guardian_result_age_seconds = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null;
msg.guardian_result_fresh = !forceStale && (testMode || (
    Number.isFinite(maximumAgeSeconds) && maximumAgeSeconds > 0 &&
    Number.isFinite(ageMs) && ageMs >= -30000 && ageMs <= maximumAgeSeconds * 1000
));
return msg;
