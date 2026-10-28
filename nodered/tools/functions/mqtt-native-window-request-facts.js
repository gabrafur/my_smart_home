msg._mqtt_window_restart=false;
msg._mqtt_window_request_state="waiting";
msg._mqtt_window_request_present=/^[a-f0-9]{64}$/.test(msg._mqtt_window_request_id??"");
msg._mqtt_window_request_duplicate=false;
msg._mqtt_window_history_count=0;
msg._mqtt_window_request_boundary=false;
try{
    const v=msg._mqtt_envelope,old=v?.canvas_checkpoint??v?.checkpoint_only?.canvas_checkpoint??null;
    if(old){
        msg._mqtt_window_history_count=old.history.length;
        msg._mqtt_window_request_duplicate=[old.window,...old.history].some(w=>w.id_sha256===msg._mqtt_window_request_id)
            || old.window_request?.id_sha256===msg._mqtt_window_request_id&&old.window_request.state==="started";
    }
    const r=v?.reader_facts,s=r?.source_facts,ack=v?.receipt_facts?.[0];
    const uint=x=>{if(typeof x!=="string"||! /^(?:0|[1-9][0-9]{0,19})$/.test(x))throw Error("integer");const n=BigInt(x);if(n>=2n**64n)throw Error("integer");return n;};
    msg._mqtt_window_request_boundary=msg._mqtt_valid===true&&msg._mqtt_commit_allowed===true
        && s?.wire_version===3&&["verified_live","verified_exited"].includes(s.identity_state)
        &&ack?.clock_ordered===true&&ack.clock_domain_sha256===r.clock_domain_sha256
        &&r.clock_domain_matches===true&&r.clock_ordered===true
        &&v.acknowledged_counts.source_epochs===s.epoch&&BigInt(v.acknowledged_counts.frames)>0n
        &&uint(s.started_boottime_ns)<=uint(ack.ack_at_ns)&&uint(ack.ack_at_ns)<=uint(s.covered_before_ns)
        &&uint(s.covered_before_ns)<=uint(r.reader_observed_boottime_ns);
}catch{ /* Missing or malformed facts keep the intent waiting. */ }
return msg;
