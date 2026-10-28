msg._mqtt_valid = false;
msg._mqtt_commit_allowed = false;
msg._mqtt_reader_authorized = null;
msg._mqtt_reader_domain = false;
msg._mqtt_reader_ordered = false;
msg._mqtt_reader_age_ms = null;
msg._mqtt_has_receipt = false;
msg._mqtt_source_state = "unknown";
msg._mqtt_observed_total = null;
msg._mqtt_unknown_total = null;
msg._mqtt_missing_total = null;
msg._mqtt_source_clock_faults = null;
msg._mqtt_integrity_faults_total = null;
msg._mqtt_receipt_unknown_total = null;
msg._mqtt_clock_ordered = false;
msg._mqtt_max_upper_ms = null;
try {
    let value = msg.payload;
    if (typeof value === "string") {
        if (value.length > 131072) return msg;
        value = JSON.parse(value);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return msg;
    if (["busy","unknown"].includes(value.state)) {
        msg._mqtt_source_state = value.state;
        return msg;
    }
    if (value.state !== "prepared" || !/^[a-f0-9]{64}$/.test(value.proposal_sha ?? "")
        || !Array.isArray(value.receipt_facts) || value.receipt_facts.length > 1) return msg;
    const uint = value => {
        if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,38})$/.test(value)) throw new Error("counter");
        const n = BigInt(value); if (n >= 2n ** 128n) throw new Error("counter"); return n;
    };
    const reader = value.reader_facts;
    if (!reader || reader.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(reader.reader_instance_sha256 ?? "")
        || ![true,false,null].includes(reader.source_authorized)
        || typeof reader.clock_domain_matches !== "boolean" || typeof reader.clock_ordered !== "boolean") return msg;
    if (reader.status_age_ns === null) {
        if (reader.status_age_ms !== null || reader.clock_ordered) return msg;
    } else {
        const ns = uint(reader.status_age_ns);
        if (ns >= 2n ** 64n || !reader.clock_domain_matches || !reader.clock_ordered
            || reader.status_age_ms !== Number((ns + 999999n) / 1000000n)) return msg;
    }
    msg._mqtt_reader_authorized = reader.source_authorized;
    msg._mqtt_reader_domain = reader.clock_domain_matches;
    msg._mqtt_reader_ordered = reader.clock_ordered;
    msg._mqtt_reader_age_ms = reader.status_age_ms;
    const kinds = MQTT_NATIVE_SCHEMA.kinds;
    const received = value.received_counts, acked = value.acknowledged_counts;
    const sameKeys = (v,keys) => v && typeof v === "object" && !Array.isArray(v)
        && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
    for (const c of [received,acked]) {
        if (!sameKeys(c,[...MQTT_NATIVE_SCHEMA.headers,"faults","stats"])
            || !sameKeys(c.stats,kinds) || !sameKeys(c.faults,MQTT_NATIVE_SCHEMA.faults)) return msg;
        for (const field of MQTT_NATIVE_SCHEMA.faults) uint(c.faults[field]);
        for (const header of MQTT_NATIVE_SCHEMA.headers) uint(c[header]);
        for (const kind of kinds) {
            const row = c.stats[kind]; if (!sameKeys(row,MQTT_NATIVE_SCHEMA.stats)) return msg;
            for (const field of MQTT_NATIVE_SCHEMA.stats) uint(row[field]);
            if (uint(row.expected) !== uint(row.observed) + uint(row.missing)
                || uint(row.observed) !== uint(row.timed) + uint(row.timing_unknown)
                || uint(row.missing) !== uint(row.source_dropped) + uint(row.transport_missing)) return msg;
        }
    }
    let observed = 0n, unknown = 0n, cumulativeUnknown = 0n, missing = 0n, maximum = null;
    for (const kind of kinds) {
        missing += uint(received.stats[kind].missing);
        cumulativeUnknown += uint(received.stats[kind].timing_unknown);
    }
    let integrityFaults = uint(received.source_clock_faults) + uint(received.report_gaps)
        + uint(received.unknown_epoch_tails) + uint(received.ack_clock_conflicts);
    if (!sameKeys(reader.faults,MQTT_NATIVE_SCHEMA.faults)) return msg;
    for (const field of MQTT_NATIVE_SCHEMA.faults) {
        const delivered = uint(received.faults[field]), current = uint(reader.faults[field]);
        integrityFaults += current > delivered ? current : delivered;
    }
    const receipt = value.receipt_facts[0];
    if (receipt) {
        uint(receipt.bucket_id);
        if (typeof receipt.clock_ordered !== "boolean" || !receipt.by_kind) return msg;
        for (const kind of kinds) {
            const row = receipt.by_kind[kind]; if (!row) return msg;
            const n = uint(row.observed), timed = uint(row.timed), u = uint(row.timing_unknown);
            if (n !== timed + u) return msg;
            observed += n; unknown += u;
            if (timed > 0n) {
                if (typeof row.source_to_consumer_upper_ns !== "string") return msg;
                const ns = uint(row.source_to_consumer_upper_ns);
                if (ns >= 2n ** 64n) return msg;
                const ms = Number((ns + 999999n) / 1000000n);
                if (row.source_to_consumer_upper_ms !== ms) return msg;
                maximum = maximum === null ? ms : Math.max(maximum, ms);
            } else if (row.source_to_consumer_upper_ns !== null || row.source_to_consumer_upper_ms !== null) return msg;
        }
        msg._mqtt_receipt_id = receipt.bucket_id;
        msg._mqtt_clock_ordered = receipt.clock_ordered;
    }
    msg._mqtt_valid = true; msg._mqtt_source_state = "prepared";
    msg._mqtt_proposal_sha = value.proposal_sha;
    msg._mqtt_has_receipt = receipt !== undefined;
    msg._mqtt_observed_total = observed.toString(); msg._mqtt_unknown_total = cumulativeUnknown.toString();
    msg._mqtt_receipt_unknown_total = unknown.toString();
    msg._mqtt_integrity_faults_total = integrityFaults.toString();
    msg._mqtt_missing_total = missing.toString();
    msg._mqtt_source_clock_faults = received.source_clock_faults;
    msg._mqtt_max_upper_ms = maximum;
    msg._mqtt_received_counts = received; msg._mqtt_acked_counts = acked;
} catch { /* Invalid source stays unknown; never copy untrusted error text. */ }
return msg;
