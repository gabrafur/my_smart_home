// Serialization and digest binding only; all outcomes came from visual nodes.
msg._mqtt_window_encoded=false;
try {
    const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v)
        : Array.isArray(v) ? "["+v.map(canonical).join(",")+"]"
        : "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";
    const digest = v => mqtt_crypto.createHash("sha256").update(canonical(v),"ascii").digest("hex");
    const c=msg._mqtt_window_candidate;
    if(msg._mqtt_window_terminal!==true){
        c.window.phase=msg._mqtt_window_phase;c.window.reason=msg._mqtt_window_reason;
        const violation=msg._mqtt_window_violation;
        if(violation && c.window.violations[violation]!==undefined)
            c.window.violations[violation]=(BigInt(c.window.violations[violation])+1n).toString();
    }
    c.acknowledged_counts_sha256=digest(msg._mqtt_window_counts);
    const raw=canonical({proposal_sha:msg._mqtt_window_proposal,checkpoint:c});
    if(Buffer.byteLength(canonical(c),"ascii")>65536 || Buffer.byteLength(raw,"ascii")>65664)return msg;
    msg._mqtt_window_commit_token="c1_"+Buffer.from(raw,"ascii").toString("base64url");
    msg._mqtt_window_checkpoint_sha=digest(c);
    msg._mqtt_window_encoded=true;
} catch { /* Encoding failure is an explicit no-effect branch. */ }
return msg;
