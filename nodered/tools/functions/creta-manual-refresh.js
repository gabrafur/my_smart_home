if (msg.payload?.event_type === "test") return null;

const requestedAt = Date.now();
node.log?.("CRETA_REFRESH_REQUESTED origin=dashboard reason=manual_force");

return {
    payload: {
        kind: "refresh_tick",
        origin: "creta_dashboard",
        reason: "manual_force",
        force_recovery: true,
        require_lighting_ready: false,
        requested_at: requestedAt
    }
};
