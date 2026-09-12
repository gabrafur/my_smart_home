const data = msg._light_arrival;
if (!data) return null;
const outcome = data.outcome;
const diagnostic = data.diagnostic ?? msg;
const recovery = data.recovery_request ?? null;
delete msg._light_arrival;
if (outcome === "ready") return [msg, diagnostic, null];
if (outcome === "blocked") return [null, msg, null];
return [null, diagnostic, recovery];
