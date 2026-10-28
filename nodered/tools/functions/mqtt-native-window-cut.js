// The visual elapsed gate selected this fixed, conservative drain boundary.
const w=msg._mqtt_window_candidate.window;
if(w.cut===null)w.cut=JSON.parse(JSON.stringify(msg._mqtt_window_cut_facts));
const a=BigInt(w.cut.accepted_frames),b=BigInt(msg._mqtt_window_counts.frames);
msg._mqtt_window_unacked_cut_frames=(a>b?a-b:0n).toString();
return msg;
