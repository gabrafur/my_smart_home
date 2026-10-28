if(msg.test_mode!==true || msg._mqtt_test_source!==true)return null;
const scenario=String(msg.payload);
const copy=v=>JSON.parse(JSON.stringify(v));
const old=copy(flow.get("mqtt_native_canvas_checkpoint_v1__test","memoryOnly")??null);
const oldSha=flow.get("mqtt_native_canvas_checkpoint_sha_v1__test","memoryOnly")??null;
const previous=flow.get("mqtt_native_fixture_v1__test","memoryOnly");
const index=(previous?._fixture_sequence??0)+1;
const counts=old?copy(previous?.acknowledged_counts??old.window.acknowledged_counts):{
    ...Object.fromEntries(MQTT_NATIVE_SCHEMA.headers.map(k=>[k,"0"])),
    faults:Object.fromEntries(MQTT_NATIVE_SCHEMA.faults.map(k=>[k,"0"])),
    stats:Object.fromEntries(MQTT_NATIVE_SCHEMA.kinds.map(k=>[k,Object.fromEntries(MQTT_NATIVE_SCHEMA.stats.map(s=>[s,"0"]))]))
};
counts.frames=old?(BigInt(counts.frames)+1n).toString():"10";
counts.sessions="1";counts.source_epochs="1";
if(scenario==="drain" && old?.window.cut?.accepted_frames
    && BigInt(counts.frames)<BigInt(old.window.cut.accepted_frames))counts.frames=old.window.cut.accepted_frames;
for(const kind of MQTT_NATIVE_SCHEMA.kinds){
    for(const key of ["expected","observed","timed"])counts.stats[kind][key]=(BigInt(counts.stats[kind][key])+1n).toString();
}
const now=old?(BigInt(old.window.started_at_ns)+86402000000000n).toString():"2000000000";
const id=old?(BigInt(old.receipt_id)+1n).toString():"1";
const by_kind=Object.fromEntries(MQTT_NATIVE_SCHEMA.kinds.map(k=>[k,{observed:"1",timed:"1",timing_unknown:"0",
    source_to_consumer_upper_ns:"1000000000",source_to_consumer_upper_ms:1000}]));
const reader={schema_version:1,reader_status_schema:2,reader_instance_sha256:"a".repeat(64),
    source_authorized:true,authorization_state:"active",clock_domain_matches:true,clock_ordered:true,
    clock_domain_sha256:"b".repeat(64),reader_observed_boottime_ns:now,
    status_age_ns:"1000000",status_age_ms:1,faults:Object.fromEntries(MQTT_NATIVE_SCHEMA.faults.map(k=>[k,"0"])),
    accepted_frames:scenario==="pending"?(BigInt(counts.frames)+2n).toString():counts.frames,
    source_facts:{epoch:"1",instance_sha256:"c".repeat(64),wire_version:3,started_boottime_ns:"100",
        emitted_boottime_ns:now,covered_before_ns:now,closed:false,identity_state:"verified_live"}};
const own=old?{state:"checkpoint_prepared",proposal_sha:(index+1000).toString(16).padStart(64,"0"),
    receipt_id:old.receipt_id,acknowledged_counts:copy(previous?.acknowledged_counts??old.window.acknowledged_counts),
    canvas_checkpoint:copy(old),canvas_checkpoint_sha256:oldSha,ack_intended:false}:null;
let cli={state:"prepared",proposal_sha:(index+100).toString(16).padStart(64,"0"),
    received_counts:counts,acknowledged_counts:copy(counts),reader_facts:reader,
    receipt_facts:[{bucket_id:id,ack_at_ns:old?now:"1000000000",clock_domain_sha256:reader.clock_domain_sha256,clock_ordered:true,by_kind}],
    canvas_checkpoint:old,canvas_checkpoint_sha256:oldSha,checkpoint_only:own,_fixture_sequence:index};
if(scenario==="source_unknown")cli={state:"unknown",collection_error:"producer_report_invalid",checkpoint_only:own,_fixture_sequence:index};
if(scenario==="epoch")reader.source_facts.epoch="2";
if(scenario==="clock"){
    reader.clock_domain_sha256="d".repeat(64);cli.receipt_facts[0].clock_domain_sha256=reader.clock_domain_sha256;
}
if(scenario==="gap")cli.receipt_facts[0].bucket_id=(BigInt(id)+1n).toString();
if(scenario==="over"){
    by_kind.publish_in.source_to_consumer_upper_ns="10000000001";
    by_kind.publish_in.source_to_consumer_upper_ms=10001;
}
if(scenario==="fault")reader.faults.source_identity_lost="1";
if(scenario==="missing"){
    const row=counts.stats.publish_in;row.expected=(BigInt(row.expected)+1n).toString();
    row.missing="1";row.source_dropped="1";
}
if(scenario==="timing_unknown"){
    const row=counts.stats.publish_in;
    for(const key of ["expected","observed"])row[key]=(BigInt(row[key])+1n).toString();
    row.timing_unknown="1";
}
if(scenario==="reader_denied"){reader.source_authorized=false;reader.authorization_state="revoked";}
if(scenario==="reader_stale"){reader.status_age_ns="10000000001";reader.status_age_ms=10001;}
if(scenario==="legacy")reader.source_facts.wire_version=2;
flow.set("mqtt_native_policy_v1__test",{enabled:true,event_latency_ms:scenario==="policy"?11000:10000},"memoryOnly");
flow.set("mqtt_native_fixture_v1__test",cli,"memoryOnly");
msg._mqtt_synthetic_cli=cli;
return msg;
