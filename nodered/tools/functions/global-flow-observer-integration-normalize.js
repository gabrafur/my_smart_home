const TEST_MODE =
    msg._global_observer_test === true ||
    msg._global_observer_integration_test === true ||
    msg.payload?.test_mode === true;

if (msg._global_observer_integration_reset === true) {
    msg._global_observer_integration_test = TEST_MODE;
    return msg;
}

const entries = Array.isArray(msg.config_entries)
    ? msg.config_entries
    : Array.isArray(msg.payload)
        ? msg.payload
        : null;

if (!entries || entries.length === 0 || entries.length > 1000) {
    node.error(
        "INTEGRATION_MONITOR_INVALID_SNAPSHOT expected_non_empty_config_entries",
        msg
    );
    return null;
}

const normalized = entries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
        entry_id: String(entry.entry_id ?? "").slice(0, 80),
        domain: String(entry.domain ?? "").slice(0, 80),
        state: String(entry.state ?? "unknown").toLowerCase().slice(0, 40),
        disabled: entry.disabled_by !== null && entry.disabled_by !== undefined
    }))
    .filter((entry) => entry.entry_id && entry.domain);

if (normalized.length === 0) {
    node.error(
        "INTEGRATION_MONITOR_INVALID_SNAPSHOT no_valid_config_entries",
        msg
    );
    return null;
}

delete msg.config_entries;
msg.payload = { test_mode: TEST_MODE };
msg._global_observer_integration_test = TEST_MODE;
msg._integration_monitor_snapshot = {
    version: 1,
    entries: normalized
};
return msg;
