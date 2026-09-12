msg.context_pending.emitted = true;
flow.set(msg.context_pending_key, msg.context_pending);
const suffix = msg._location_test === true ? "__test" : "";
msg.context_people = flow.get(`people_context_v1${suffix}`) || {};
msg.context_vehicle = flow.get(`vehicle_primary_context_v1${suffix}`) || {};
return msg;
