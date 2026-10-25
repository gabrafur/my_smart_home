// A separate copy of the real result path; never changes the decision message.
if (msg._git_backup_test === true) return null;
const safe = value => {
    if (!value || typeof value !== "object") return null;
    return {
        status: ["success", "failed", "deferred", "invalid"].includes(value.status) ? value.status : "unknown",
        reason: /^[a-z0-9_]{1,80}$/.test(value.reason ?? "") ? value.reason : "unknown",
        finished_at: typeof value.finished_at === "string" ? value.finished_at.slice(0, 40) : null,
        request_id: /^[0-9]{8}T[0-9]{6}Z-[0-9]+$/.test(value.request_id ?? "") ? value.request_id : null,
        origin: ["scheduled", "manual"].includes(value.origin) ? value.origin : "unknown",
    };
};
const history = flow.get("git_backup_failure_history_v1", "persistent");
return { payload: JSON.stringify({
    schema_version: 1,
    source: "canonical_nodered_git_backup_result",
    observed_at: new Date().toISOString(),
    last_result: safe(flow.get("git_backup_last_result_v1", "persistent")),
    last_scheduled_cycle: safe(flow.get("git_backup_last_scheduled_result_v1", "persistent")),
    failure_history: Array.isArray(history) ? history.slice(-16).map(safe).filter(Boolean) : [],
    history_coverage: "last_16_known_failures;older_or_missing_records_not_inferred",
    origin_coverage: "canonical_message_topic_and_helper_request_id;not_cryptographic_scheduler_attestation",
    offsite_success_inferred: false,
    restoration_inferred: false,
}) };
