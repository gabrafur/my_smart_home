node.log("SECURITY_LIGHT_OFF_ACCEPTED " + JSON.stringify({
    ...(msg.payload?.off_diagnostic ?? {}), accepted_at: Date.now(), dispatched: true
}));
return null;
