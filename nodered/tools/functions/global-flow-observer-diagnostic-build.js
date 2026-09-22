// Protocol adapter: preserve error evidence without serializing the incoming msg.
const test = msg._global_observer_test === true || msg.payload?.test_mode === true;
const error = msg.error;
const domain = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
// Node errors are already recorded at catch ingress, before notification gates.
if (msg._observer_diagnostic_origin === "dispatch" && domain.observer_kind === "node_error") return null;
if (!error && !msg.alert) return null;
const clipped = [];
const clean = (value, field) => {
    if (value === undefined || value === null) return null;
    let text = String(value)
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
        .replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>)]*/gi, "$1?[REDACTED]")
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, "$1 [REDACTED]")
        .replace(/((?:["']?)(?:password|passwd|token|access_token|refresh_token|api[_-]?key|authorization|cookie|secret|clientId|dsid)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    if (text.length > 20000) { clipped.push(field); text = text.slice(0, 20000); }
    return text;
};
const seen = new Set();
const describe = (value, depth = 0) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object") return { message: clean(value, "cause") };
    if (seen.has(value) || depth >= 8) { clipped.push("cause_chain"); return { message: "[cause chain limited]" }; }
    seen.add(value);
    return {
        name: clean(value.name, "error.name"), message: clean(value.message, "error.message"),
        code: clean(value.code, "error.code"), stack: clean(value.stack, "error.stack"),
        cause: describe(value.cause, depth + 1)
    };
};
const observer = msg._global_observer ?? msg._observer_event ?? {};
const source = error?.source ?? {};
const now = new Date(test ? Number(msg.observer_now ?? Date.now()) : Date.now()).toISOString();
const details = {};
for (const key of ["reason", "status", "request_id", "exit_code", "signal", "stderr", "stdout"]) {
    const value = msg.observer_diagnostic?.[key] ?? domain[key] ?? msg[key];
    if (["string", "number", "boolean"].includes(typeof value)) details[key] = clean(value, key);
}
const record = {
    version: 1, recorded_at: now, event_type: error ? "node_error" : clean(domain.observer_kind ?? "domain_alert", "kind"),
    correlation_id: clean(msg._msgid, "correlation_id"),
    flow_id: clean(observer.flow_id ?? domain.flow_id, "flow_id"),
    flow_label: clean(observer.flow_label, "flow_label"),
    source_id: clean(source.id ?? domain.source_id, "source_id"),
    source_type: clean(source.type, "source_type"), source_name: clean(source.name, "source_name"),
    incident_key: clean(domain.incident_key, "incident_key"),
    error: describe(error), details,
    alert: msg.alert ? { title: clean(msg.alert.title, "alert.title"), message: clean(msg.alert.message, "alert.message") } : null,
    sources: (msg._observer_evaluation?.sources ?? []).map(entry => ({
        flow_id: clean(entry.flow_id, "status.flow_id"), source_id: clean(entry.source_id, "status.source_id"),
        source_name: clean(entry.source_name, "status.source_name"), status_text: clean(entry.status_text, "status.text"),
        first_seen_at: entry.first_seen_at, last_seen_at: entry.last_seen_at
    })),
    truncated_fields: clipped, test_mode: test
};
msg._observer_diagnostic_record = record;
msg._observer_diagnostic_test = test;
msg.payload = JSON.stringify(record);
msg.filename = `/data/failure-history/${now.slice(0, 13)}.jsonl`;
return msg;
