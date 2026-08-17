const allowedPresenceRoles = new Set(["resident_primary", "resident_secondary"]);
const allowedHealthSubsystems = new Set(["internet", "zigbee"]);

function clone(value) {
  return structuredClone(value);
}

function action(type, target, reason) {
  return { type, target, reason, simulated: true, dispatched: false };
}

function alertKey(subsystem) {
  return `${subsystem}_health`;
}

export function runSyntheticScenario(scenario) {
  if (!scenario || scenario.schema_version !== 1 || scenario.synthetic !== true || !Array.isArray(scenario.events)) {
    throw new Error("demo scenario must be explicitly synthetic");
  }
  const state = clone(scenario.initial_state);
  const activeAlerts = new Set();
  const timeline = [];
  const metrics = { events: 0, alerts: 0, recoveries: 0, simulated_actions: 0 };

  for (const event of scenario.events) {
    if (!Number.isInteger(event.step) || event.step <= 0) throw new Error("demo event step is invalid");
    const actions = [];
    const observations = [];
    if (event.type === "vehicle.approaching") {
      if (event.role !== "vehicle_primary") throw new Error("demo vehicle role is invalid");
      state.vehicle_primary = "approaching";
      observations.push("arrival-context-opened");
      if (state.ambient === "dark" && state.exterior_light === "off") {
        state.exterior_light = "on";
        actions.push(action("logical-light-on", "exterior_light", "synthetic-arrival"));
      }
    } else if (event.type === "presence.arrival") {
      if (!allowedPresenceRoles.has(event.role)) throw new Error("demo resident role is invalid");
      state.presence[event.role] = "home";
      state.vehicle_primary = "home";
      observations.push("presence-confirmed");
      if (state.security_panel === "armed_away") {
        state.security_panel = "disarm-requested";
        actions.push(action("logical-security-disarm", "security_panel", "synthetic-authorized-arrival"));
      }
    } else if (event.type === "storage.pressure") {
      state.storage = event.level === "warning" ? "warning" : "critical";
      if (!activeAlerts.has("storage_health")) {
        activeAlerts.add("storage_health");
        metrics.alerts += 1;
        observations.push("storage-alert-created");
      }
    } else if (event.type === "storage.recovered") {
      state.storage = "healthy";
      if (activeAlerts.delete("storage_health")) {
        metrics.recoveries += 1;
        observations.push("storage-recovery-recorded");
      }
    } else if (event.type === "health.changed") {
      if (!allowedHealthSubsystems.has(event.subsystem) || !["online", "offline"].includes(event.state)) throw new Error("demo health event is invalid");
      state[event.subsystem] = event.state;
      const key = alertKey(event.subsystem);
      if (event.state === "offline" && !activeAlerts.has(key)) {
        activeAlerts.add(key);
        metrics.alerts += 1;
        observations.push(`${event.subsystem}-alert-created`);
      } else if (event.state === "online" && activeAlerts.delete(key)) {
        metrics.recoveries += 1;
        observations.push(`${event.subsystem}-recovery-recorded`);
      }
    } else if (event.type === "lighting.timeout") {
      if (event.role !== "exterior_light") throw new Error("demo lighting role is invalid");
      state.exterior_light = "off";
      actions.push(action("logical-light-off", "exterior_light", "synthetic-timeout"));
    } else {
      throw new Error(`unsupported synthetic event: ${event.type}`);
    }
    metrics.events += 1;
    metrics.simulated_actions += actions.length;
    timeline.push({ step: event.step, event: event.type, observations, actions, active_alerts: [...activeAlerts].sort() });
  }

  return {
    schema_version: 1,
    synthetic: true,
    network_access: false,
    device_access: false,
    credentials_used: false,
    final_state: state,
    active_alerts: [...activeAlerts].sort(),
    metrics,
    timeline,
  };
}
