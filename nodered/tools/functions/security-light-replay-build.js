const data = msg._light_context;
const pending = data.pending;
if (!pending && data.engine_on_arrival) {
    data.replay = data.engine_on_arrival;
    return msg;
}
if (!pending) return msg;
const replay = {
    ...pending.message,
    payload: {
        ...(pending.message.payload ?? {}),
        arrival_replayed_after_context_recovery: true,
        arrival_originally_queued_at: pending.queued_at,
        arrival_replayed_at: data.now,
        engine_bypass_enabled: data.bypass_enabled,
        engine_bypass_allowed: data.bypass_allowed
    },
    _arrival_replay: true
};
if (data.test_mode) {
    replay._location_test = true;
    replay._location_test_case = data.test_case ?? pending.message._location_test_case ?? null;
    replay.payload.test_mode = true;
    replay.payload.test_case = replay._location_test_case;
}
data.replay = replay;
return msg;
