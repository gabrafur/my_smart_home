const s = msg.storage;
const state = s.state;
s.retry_due = false;
s.error_due = false;
if (s.valid) {
    s.collection_recovered = state.collectionIncidentOpen === true;
    state.collectionFailureCount = 0;
    state.collectionNextRetryAt = 0;
    state.collectionStatus = "ok";
    state.lastValidReadAt = s.now;
    state.collectionIncidentOpen = false;
    if (state.pendingAlert?.collection_error || state.pendingAlert?.payload?.title === "Raspberry Pi - storage indisponivel") state.pendingAlert = null;
} else {
    if (!state.collectionFailureCount) state.collectionFailureStartedAt = s.now;
    const due = !state.collectionNextRetryAt || s.now >= state.collectionNextRetryAt;
    if (due) state.collectionFailureCount = Number(state.collectionFailureCount || 0) + 1;
    s.retry_due = due && state.collectionFailureCount <= msg.policy.collection_max_retries;
    if (s.retry_due) state.collectionNextRetryAt = s.now + msg.policy.collection_retry_delay_s * 1000;
    state.collectionStatus = state.collectionFailureCount > msg.policy.collection_max_retries ? "read_error" : "retrying";
    s.error_due = state.collectionStatus === "read_error" && (!state.lastCollectionErrorNotificationAt ||
        s.now - state.lastCollectionErrorNotificationAt >= msg.policy.command_error_cooldown_h * 3600000);
}
return msg;
