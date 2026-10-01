const result = { ...(msg.payload.off_diagnostic ?? {}), version: 1,
    simulated: true, dispatched: false, actions: ["switch.turn_off:exterior_light"] };
flow.set("security_light_last_off_dry_run_v1__test", result);
node.log?.("SECURITY_LIGHT_OFF_DRY_RUN " + JSON.stringify(result));
return null;
