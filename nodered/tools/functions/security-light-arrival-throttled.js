const data = msg._light_arrival;
data.diagnostic.payload.context_recovery_requested = false;
data.diagnostic.payload.context_recovery_throttled = true;
data.outcome = "pending";
return msg;
