const key = "startup_pending" + (msg._startup_test === true ? "__test" : "");
const current = flow.get(key, "memoryOnly");
if (!current || current.revision !== msg.pending.revision) return null;
flow.set(key, undefined, "memoryOnly");
return msg;
