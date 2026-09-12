const data = msg._light_reconcile;
const scheduled = flow.get("security_light_recovery_scheduled") ?? {};
const current = Object.fromEntries(data.deadlines.map((deadline) => [deadline.type, deadline.at]));
for (const type of Object.keys(scheduled)) if (scheduled[type] !== current[type]) delete scheduled[type];
data.messages = [];
for (const deadline of data.deadlines) {
    if (scheduled[deadline.type] === deadline.at) continue;
    scheduled[deadline.type] = deadline.at;
    data.messages.push({ payload: { event: "turn_off", reason: deadline.reason,
        deadline_type: deadline.type, recovered: true }, delay: Math.max(0, deadline.at - data.now) });
}
flow.set("security_light_recovery_scheduled", scheduled);
return msg;
