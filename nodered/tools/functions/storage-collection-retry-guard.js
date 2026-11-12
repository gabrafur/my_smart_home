const r = msg.storageRetry;
if (!r || msg.test_mode === true) return null;
const state = flow.get(r.stateKey, "persistent");
if (!state || state.collectionStatus === "ok" || state.collectionFailureStartedAt !== r.startedAt ||
    state.collectionFailureCount !== r.attempt || state.collectionNextRetryAt !== r.dueAt) return null;
return {};
