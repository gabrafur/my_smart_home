// Shape validation and exact arithmetic only. Switches choose every outcome.
msg._mqtt_window_possible = false;
msg._mqtt_window_candidate = null;
try {
    const uint = (v,bits=128) => {
        if (typeof v !== "string" || !/^(?:0|[1-9][0-9]{0,38})$/.test(v)) throw Error("integer");
        const n=BigInt(v); if(n>=2n**BigInt(bits))throw Error("integer"); return n;
    };
    const hex = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    const copy = v => JSON.parse(JSON.stringify(v));
    const value = msg._mqtt_envelope;
    if (!value || value.state === "busy") return msg;
    const own = value.checkpoint_only;
    const source = msg._mqtt_valid === true && msg._mqtt_commit_allowed === true;
    const plan = source ? value : own;
    if (!plan || !hex(plan.proposal_sha)) return msg;
    const old = plan.canvas_checkpoint ?? null;
    if (!source && old === null) return msg;
    const receipt = source ? value.receipt_facts[0] : null;
    const receiptId = source ? (receipt?.bucket_id ?? own?.receipt_id ?? "0") : plan.receipt_id;
    uint(receiptId,64);
    const counts = plan.acknowledged_counts;
    const leaves = c => [...MQTT_NATIVE_SCHEMA.headers.map(k=>c[k]),
        ...MQTT_NATIVE_SCHEMA.faults.map(k=>c.faults[k]),
        ...MQTT_NATIVE_SCHEMA.kinds.flatMap(k=>MQTT_NATIVE_SCHEMA.stats.map(s=>c.stats[k][s]))];
    leaves(counts).forEach(v=>uint(v));
    if (old !== null && (!hex(plan.canvas_checkpoint_sha256) || old.schema_version !== 1
        || !hex(old.window?.id_sha256) || !Array.isArray(old.history))) return msg;
    const reader = source ? value.reader_facts : null;
    const origin = reader?.source_facts;
    const now = reader?.reader_observed_boottime_ns ?? old?.window.observed_at_ns;
    if (now === undefined) return msg;
    uint(now,64);
    const knownOrigin = origin != null && origin.wire_version === 3 && hex(origin.instance_sha256)
        && ["verified_live","verified_exited"].includes(origin.identity_state)
        && typeof origin.closed === "boolean" && origin.covered_before_ns !== null;
    if (knownOrigin) {
        uint(origin.epoch);uint(origin.covered_before_ns,64);
        if(uint(origin.covered_before_ns,64)>uint(now,64))return msg;
    }
    const knownClock = hex(reader?.clock_domain_sha256) && reader.clock_domain_matches === true
        && reader.clock_ordered === true && (receipt == null || receipt.clock_ordered === true
            && receipt.clock_domain_sha256 === reader.clock_domain_sha256);
    const start = old?.window.started_at_ns ?? receipt?.ack_at_ns;
    if (start !== undefined) uint(start,64);
    const validBoundary = receipt != null && uint(receiptId,64)>0n && knownClock
        && start !== undefined && uint(start,64)<=uint(now,64) && knownOrigin
        && counts.source_epochs===origin.epoch && uint(counts.frames)>0n
        && origin.started_boottime_ns !== null && uint(origin.started_boottime_ns,64)<=uint(start,64)
        && uint(origin.covered_before_ns,64)>=uint(start,64);
    // No clock/start is fabricated for a missing first verified ACK boundary.
    if (old === null && !validBoundary) return msg;
    const policy = {event_latency_ms:String(msg._mqtt_policy.event_latency_ms),
        window_duration_ns:(BigInt(msg._mqtt_window_contract.duration_ms)*1000000n).toString()};
    const w = old === null ? {
        id_sha256:plan.proposal_sha,phase:"tracking",reason:"collecting",
        clock_domain_sha256:reader.clock_domain_sha256,started_at_ns:start,observed_at_ns:now,
        first_receipt_id:receiptId,last_receipt_id:receiptId,baseline_counts:copy(counts),
        acknowledged_counts:copy(counts),max_upper_ns_by_kind:Object.fromEntries(MQTT_NATIVE_SCHEMA.kinds.map(k=>[k,null])),
        violations:Object.fromEntries(["missing","timing_unknown","integrity_faults","receipt_gaps",
            "clock_conflicts","over_contract_receipts","reader_unknown_observations"].map(k=>[k,"0"])),policy,cut:null
    } : copy(old.window);
    const next = {schema_version:1,sequence:(uint(old?.sequence ?? "0",64)+1n).toString(),
        previous_sha256:old === null ? null : plan.canvas_checkpoint_sha256,
        proposal_sha:plan.proposal_sha,receipt_id:receiptId,acknowledged_counts_sha256:null,
        window:w,history:copy(old?.history ?? [])};
    msg._mqtt_window_candidate=next;
    msg._mqtt_window_counts=copy(counts);
    msg._mqtt_window_mode=source ? "commit" : "checkpoint-commit";
    msg._mqtt_window_proposal=plan.proposal_sha;
    msg._mqtt_window_terminal=["passed","failed","unknown"].includes(w.phase);
    msg._mqtt_window_current_phase=w.phase;
    msg._mqtt_window_reader_good=source && knownOrigin;
    msg._mqtt_window_clock_good=knownClock && reader.clock_domain_sha256===w.clock_domain_sha256
        && uint(now,64)>=uint(w.observed_at_ns,64);
    msg._mqtt_window_policy_same=policy.event_latency_ms===w.policy.event_latency_ms
        && policy.window_duration_ns===w.policy.window_duration_ns;
    msg._mqtt_window_epoch_equal=knownOrigin && origin.epoch===counts.source_epochs
        && (old===null || counts.source_epochs===w.baseline_counts.source_epochs);
    const current = source ? value.received_counts : counts;
    const prior=leaves(w.baseline_counts),currentLeaves=leaves(current),ackLeaves=leaves(counts),lastLeaves=leaves(w.acknowledged_counts);
    const monotonic=currentLeaves.every((v,i)=>uint(v)>=uint(prior[i]))
        &&ackLeaves.every((v,i)=>uint(v)>=uint(lastLeaves[i]));
    msg._mqtt_window_monotonic=monotonic;
    const delta = (a,b) => uint(a)>=uint(b) ? uint(a)-uint(b) : 0n;
    let missing=0n,unknown=0n,faults=0n;
    for(const kind of MQTT_NATIVE_SCHEMA.kinds){
        missing+=delta(current.stats[kind].missing,w.baseline_counts.stats[kind].missing);
        unknown+=delta(current.stats[kind].timing_unknown,w.baseline_counts.stats[kind].timing_unknown);
        const upper=receipt?.by_kind[kind].source_to_consumer_upper_ns;
        if(upper!=null && (w.max_upper_ns_by_kind[kind]===null || uint(upper,64)>uint(w.max_upper_ns_by_kind[kind],64)))
            w.max_upper_ns_by_kind[kind]=upper;
    }
    for(const k of ["report_gaps","unknown_epoch_tails","source_clock_faults","ack_clock_conflicts"])
        faults+=delta(current[k],w.baseline_counts[k]);
    for(const k of MQTT_NATIVE_SCHEMA.faults){
        const delivered=uint(current.faults[k]),live=reader?uint(reader.faults[k]):delivered;
        faults+=delta((live>delivered?live:delivered).toString(),w.baseline_counts.faults[k]);
    }
    const oldReceipt=uint(old?.window.last_receipt_id ?? receiptId,64),id=uint(receiptId,64);
    msg._mqtt_window_receipt_contiguous=id===oldReceipt && receipt==null || receipt!=null
        && (old===null || id===oldReceipt+1n);
    msg._mqtt_window_missing=missing.toString();msg._mqtt_window_unknown=unknown.toString();
    msg._mqtt_window_faults=faults.toString();
    const maxima=Object.values(w.max_upper_ns_by_kind).filter(v=>v!==null).map(v=>uint(v,64));
    const max=maxima.reduce((a,b)=>a>b?a:b,0n);
    msg._mqtt_window_max_upper_ms=Number((max+999999n)/1000000n);
    const before=knownOrigin?uint(origin.covered_before_ns,64):0n;
    msg._mqtt_window_elapsed_ms=before>=uint(w.started_at_ns,64)?Number((before-uint(w.started_at_ns,64))/1000000n):0;
    msg._mqtt_window_has_cut=w.cut!==null;
    msg._mqtt_window_cut_is_coverage=w.cut===null || Object.hasOwn(w.cut,"covered_before_ns");
    msg._mqtt_window_cut_facts=knownOrigin?{accepted_frames:reader.accepted_frames,covered_before_ns:origin.covered_before_ns}:null;
    msg._mqtt_window_unacked_cut_frames=w.cut===null?"0":(uint(w.cut.accepted_frames)>uint(counts.frames)?uint(w.cut.accepted_frames)-uint(counts.frames):0n).toString();
    if(!msg._mqtt_window_terminal){
        if(uint(now,64)>=uint(w.observed_at_ns,64))w.observed_at_ns=now;
        w.last_receipt_id=receiptId;w.acknowledged_counts=copy(counts);
        for(const [key,n]of [["missing",missing],["timing_unknown",unknown],["integrity_faults",faults]])
            if(n>uint(w.violations[key]))w.violations[key]=n.toString();
    } else next.window=copy(old.window);
    msg._mqtt_window_possible=true;
} catch { /* Invalid metadata never authorizes a new ACK or positive window. */ }
return msg;
