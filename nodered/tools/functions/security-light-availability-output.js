const output = msg._light_availability?.output;
delete msg._light_availability;
if (output === 0) return [msg, null, null];
if (output === 1) return [null, msg, null];
if (output === 2) return [null, null, msg];
return [null, null, null];
