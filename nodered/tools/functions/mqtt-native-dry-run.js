if (msg.test_mode !== true) return null;
const previous = flow.get(msg._mqtt_key,"memoryOnly") ?? {};
if (msg._mqtt_operation === "commit") previous.last_committed_proposal_sha = msg._mqtt_proposal_sha;
previous.last_commit_state = "simulated";
flow.set(msg._mqtt_key,previous,"memoryOnly");
flow.set("mqtt_native_last_dry_run_v1__test",{
    version:1,simulated:true,dispatched:false,external_call_sent:false,
    operation:msg._mqtt_operation,classification:msg._mqtt_classification,
    proposal_sha:msg._mqtt_proposal_sha ?? null,
    receipt_id:msg._mqtt_receipt_id ?? null
},"memoryOnly");
if (msg._mqtt_owns_flight === true && typeof msg._mqtt_flight_token === "string"
    && flow.get(msg._mqtt_flight_key,"memoryOnly")?.token === msg._mqtt_flight_token)
    flow.set(msg._mqtt_flight_key,false,"memoryOnly");
msg._global_observer_test = true;
msg.payload = {test_mode:true,observer_kind:"metadata_observation",flow_id:"mqtt_native_observer_tab",source_id:"metadata_fixture"};
return msg;
