const base=msg.home_refresh_due_base;
const vehicleAt=Number(base.vehicle.updated_at ?? 0);
const engineOn = base.vehicle.engine_state_valid === true && base.vehicle.engine_on === true;
const requestAt = Number(base.vehicle.refresh?.last_request_at ?? 0);
const roles=["resident_primary","resident_secondary"];
const items = Object.entries(base.pending_state.residents ?? {})
    .filter(([source, item]) => roles.includes(source) && item)
    .map(([source, pending]) => {
        const resident = base.people[source] ?? {};
        const away = resident.ready === true && resident.stale !== true && resident.current_home === false;
        const off = base.vehicle.engine_state_valid === true &&
            base.vehicle.engine_on === false &&
            vehicleAt >= Number(pending.arrival_observed_at ?? 0);
        const ack = Number(pending.issued_at ?? 0) > 0 && requestAt >= Number(pending.issued_at);
        const expired = base.now > Number(pending.expires_at);
        const due = base.now >= Number(pending.due_at);
        const allows = !off && (engineOn || pending.engine_on_at_arrival === true);
        const retry = base.now >= Number(pending.next_emit_at ?? pending.due_at);
        const priority = ack ? 0 : expired || away || off ? 1 : due && allows && retry ? 2 : 3;
        return { pending, away, off, ack, expired, due, allows, retry, priority };
    })
    .sort((a, b) => a.priority - b.priority || Number(a.pending.due_at ?? Infinity) - Number(b.pending.due_at ?? Infinity));
const pick = items[0];
msg.home_refresh_due = { pending_key: base.pending_key, pending_state: base.pending_state,
    pending: pick?.pending ?? null, now: base.now, exists: Boolean(pick),
    request_observed: pick?.ack === true, expired: pick?.expired === true,
    explicit_away: pick?.away === true, explicit_engine_off: pick?.off === true,
    due: pick?.due === true, engine_allows: pick?.allows === true, retry_due: pick?.retry === true };
delete msg.home_refresh_due_base;
return msg;
