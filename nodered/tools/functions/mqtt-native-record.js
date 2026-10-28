const previous = flow.get(msg._mqtt_key, msg._mqtt_store) ?? {};
const snapshot = {
    version:1,
    classification:msg._mqtt_classification,
    reader_authorized:msg._mqtt_reader_authorized ?? null,
    reader_clock_domain_matches:msg._mqtt_reader_domain ?? null,
    reader_clock_ordered:msg._mqtt_reader_ordered ?? null,
    reader_status_age_ms:msg._mqtt_reader_age_ms ?? null,
    source_state:msg._mqtt_source_state ?? "unknown",
    received_counts:msg._mqtt_received_counts ?? previous.received_counts ?? null,
    acknowledged_counts:msg._mqtt_acked_counts ?? previous.acknowledged_counts ?? null,
    last_receipt_id:msg._mqtt_receipt_id ?? previous.last_receipt_id ?? null,
    observed_total:msg._mqtt_observed_total ?? null,
    timing_unknown_total:msg._mqtt_unknown_total ?? null,
    receipt_timing_unknown_total:msg._mqtt_receipt_unknown_total ?? null,
    integrity_faults_total:msg._mqtt_integrity_faults_total ?? previous.integrity_faults_total ?? null,
    classification_scope:"latest_receipt_with_cumulative_integrity_gates",
    missing_total:msg._mqtt_missing_total ?? previous.missing_total ?? null,
    max_source_to_consumer_upper_ms:msg._mqtt_max_upper_ms ?? null,
    last_committed_proposal_sha:previous.last_committed_proposal_sha ?? null,
    last_commit_state:previous.last_commit_state ?? null,
    full24h_proven:false,all_event_latency_proven:false
};
flow.set(msg._mqtt_key,snapshot,msg._mqtt_store);
return msg;
