if (msg.test_mode !== true || msg._mqtt_test_source !== true) return null;
const scenario = String(msg.payload);
if (scenario === "reset") {
    for (const key of ["mqtt_native_observer_v1__test","mqtt_native_fixture_v1__test","mqtt_native_last_dry_run_v1__test",
        "mqtt_native_inflight_v1__test","mqtt_native_inflight_v1__test_sequence",
        "mqtt_native_canvas_checkpoint_v1__test","mqtt_native_canvas_checkpoint_sha_v1__test",
        "mqtt_native_consumer_instance_v1__test","mqtt_native_window_request_v1__test"]) flow.set(key,undefined,"memoryOnly");
    return null;
}
const previous = flow.get("mqtt_native_fixture_v1__test","memoryOnly");
let cli;
if (scenario === "duplicate" && previous) cli = JSON.parse(JSON.stringify(previous));
else {
    const index = (previous?._fixture_sequence ?? 0) + 1;
    const counts = {...Object.fromEntries(MQTT_NATIVE_SCHEMA.headers.map(k=>[k,"0"])),
        faults:Object.fromEntries(MQTT_NATIVE_SCHEMA.faults.map(k=>[k,"0"])),
        stats:Object.fromEntries(MQTT_NATIVE_SCHEMA.kinds.map(k=>[k,Object.fromEntries(MQTT_NATIVE_SCHEMA.stats.map(s=>[s,"0"]))]))};
    counts.frames = "1"; counts.sessions = "1"; counts.source_epochs = "1";
    const row = counts.stats.publish_in; row.expected = "1"; row.observed = "1"; row.timed = "1";
    const by_kind = Object.fromEntries(MQTT_NATIVE_SCHEMA.kinds.map(k=>[k,{observed:"0",timed:"0",timing_unknown:"0",
        source_to_consumer_upper_ns:null,source_to_consumer_upper_ms:null}]));
    by_kind.publish_in = {observed:"1",timed:"1",timing_unknown:"0",source_to_consumer_upper_ns:"1000000000",source_to_consumer_upper_ms:1000};
    cli = {state:"prepared",proposal_sha:index.toString(16).padStart(64,"0"),
        reader_facts:{schema_version:1,reader_instance_sha256:"a".repeat(64),source_authorized:true,authorization_state:"active",faults:Object.fromEntries(MQTT_NATIVE_SCHEMA.faults.map(k=>[k,"0"])),clock_domain_matches:true,clock_ordered:true,status_age_ns:"1000000",status_age_ms:1},received_counts:counts,acknowledged_counts:JSON.parse(JSON.stringify(counts)),
        receipt_facts:[{bucket_id:String(index),clock_ordered:true,by_kind}],_fixture_sequence:index};
    if (scenario === "reader_denied") {cli.reader_facts.source_authorized=false;cli.reader_facts.authorization_state="revoked";}
    if (scenario === "reader_clock" || scenario === "reader_future") {
        cli.reader_facts.clock_domain_matches=scenario!=="reader_clock";cli.reader_facts.clock_ordered=false;
        cli.reader_facts.status_age_ns=null;cli.reader_facts.status_age_ms=null;
    }
    if (scenario === "reader_stale") {cli.reader_facts.status_age_ns="10000000001";cli.reader_facts.status_age_ms=10001;}
    if (scenario === "reader_missing") delete cli.reader_facts;
    if (scenario === "over") {
        by_kind.publish_in.source_to_consumer_upper_ns = "10000000001"; by_kind.publish_in.source_to_consumer_upper_ms = 10001;
    } else if (scenario === "unknown") {
        cli.receipt_facts[0].clock_ordered = false;
        row.timed = "0"; row.timing_unknown = "1";
        by_kind.publish_in.timed = "0"; by_kind.publish_in.timing_unknown = "1";
        by_kind.publish_in.source_to_consumer_upper_ns = null; by_kind.publish_in.source_to_consumer_upper_ms = null;
    } else if (scenario === "missing") {
        row.expected = "2"; row.missing = "1"; row.source_dropped = "1";
    } else if (scenario === "no_events") {
        for (const k of MQTT_NATIVE_SCHEMA.stats) row[k] = "0";
        by_kind.publish_in = {observed:"0",timed:"0",timing_unknown:"0",source_to_consumer_upper_ns:null,source_to_consumer_upper_ms:null};
    } else if (scenario === "unavailable") cli = {state:"unknown",collection_error:"producer_report_invalid",_fixture_sequence:index};
    else if (scenario === "busy") cli = {state:"busy",_fixture_sequence:index};
    else if (scenario === "malformed") cli = "invalid_synthetic_metadata";
}
if (typeof cli === "object") flow.set("mqtt_native_fixture_v1__test",cli,"memoryOnly");
msg._mqtt_synthetic_cli = cli;
msg._mqtt_test_enabled = scenario !== "disabled";
return msg;
