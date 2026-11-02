flow.set("external_lighting_zigbee_state__test", null);
flow.set("external_lighting_recovery_pending_v1__test", null);
flow.set("external_lighting_recovery_prompted_date_v1__test", null);
for (const key of ['external_pending_v1__test', 'external_confirmation_incident_v1__test', 'external_confirmation_expectation_v2__test']) flow.set(key, null);
flow.set('external_confirmation_epoch_v2__test', null, 'memoryOnly');
flow.set("external_lighting_last_dry_run_v1", { version: 1, reset: true, simulated: true, dispatched: false });
return null;
