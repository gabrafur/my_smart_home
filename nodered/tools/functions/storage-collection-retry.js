const s = msg.storage;
if (!s.retry_due) return null;
return { test_mode: s.testMode, delay: msg.policy.collection_retry_delay_s * 1000,
    storageRetry: { startedAt: s.state.collectionFailureStartedAt, dueAt: s.state.collectionNextRetryAt,
        attempt: s.state.collectionFailureCount, stateKey: s.stateKey } };
