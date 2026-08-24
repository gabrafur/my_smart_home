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
  let state = clone(scenario.initial_state);
  const activeAlerts = new Set();
  const lastHealthSequence = new Map();
  const timeline = [];
  const metrics = {
    events: 0,
    events_applied: 0,
    alerts: 0,
    recoveries: 0,
    deduplicated: 0,
    stale_rejected: 0,
    restart_restores: 0,
    simulated_actions: 0,
  };

  for (const event of scenario.events) {
    if (!Number.isInteger(event.step) || event.step <= 0) throw new Error("demo event step is invalid");
    const actions = [];
    const observations = [];
    let outcome = "applied";
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
      if (!Number.isInteger(event.sequence) || event.sequence <= 0) throw new Error("demo health sequence is invalid");
      const previousSequence = lastHealthSequence.get(event.subsystem) ?? 0;
      if (event.sequence <= previousSequence) {
        metrics.stale_rejected += 1;
        outcome = "rejected_stale";
        observations.push(`${event.subsystem}-stale-event-rejected`);
      } else {
        lastHealthSequence.set(event.subsystem, event.sequence);
        const key = alertKey(event.subsystem);
        if (state[event.subsystem] === event.state) {
          metrics.deduplicated += 1;
          outcome = "deduplicated";
          observations.push(`${event.subsystem}-alert-deduplicated`);
        } else {
          state[event.subsystem] = event.state;
          if (event.state === "offline" && !activeAlerts.has(key)) {
            activeAlerts.add(key);
            metrics.alerts += 1;
            observations.push(`${event.subsystem}-alert-created`);
          } else if (event.state === "online" && activeAlerts.delete(key)) {
            metrics.recoveries += 1;
            observations.push(`${event.subsystem}-recovery-recorded`);
          }
        }
      }
    } else if (event.type === "runtime.restart") {
      const persisted = clone({
        state,
        active_alerts: [...activeAlerts],
        last_health_sequence: Object.fromEntries(lastHealthSequence),
      });
      state = clone(persisted.state);
      activeAlerts.clear();
      for (const key of persisted.active_alerts) activeAlerts.add(key);
      lastHealthSequence.clear();
      for (const [subsystem, sequence] of Object.entries(persisted.last_health_sequence)) {
        lastHealthSequence.set(subsystem, sequence);
      }
      metrics.restart_restores += 1;
      outcome = "restart_reloaded";
      observations.push("restart-state-restored");
    } else if (event.type === "lighting.timeout") {
      if (event.role !== "exterior_light") throw new Error("demo lighting role is invalid");
      state.exterior_light = "off";
      actions.push(action("logical-light-off", "exterior_light", "synthetic-timeout"));
    } else {
      throw new Error(`unsupported synthetic event: ${event.type}`);
    }
    metrics.events += 1;
    if (!["deduplicated", "rejected_stale"].includes(outcome)) metrics.events_applied += 1;
    metrics.simulated_actions += actions.length;
    timeline.push({ step: event.step, event: event.type, outcome, observations, actions, active_alerts: [...activeAlerts].sort() });
  }

  return {
    schema_version: 1,
    scenario: scenario.name,
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

function observations(result, suffix) {
  return result.timeline
    .flatMap((entry) => entry.observations)
    .filter((observation) => observation.endsWith(suffix));
}

export function formatSyntheticSummary(result) {
  if (!result?.synthetic || !Array.isArray(result.timeline)) throw new Error("demo result is invalid");
  const dispatchedActions = result.timeline
    .flatMap((entry) => entry.actions)
    .filter((entry) => entry.dispatched).length;
  const arrival = result.timeline
    .flatMap((entry) => entry.observations)
    .filter((entry) => ["arrival-context-opened", "presence-confirmed"].includes(entry));
  const degradations = observations(result, "-alert-created").filter((entry) => entry !== "storage-alert-created");
  const recovered = observations(result, "-recovery-recorded");

  return [
    `Synthetic smart-home recovery demo: ${result.scenario}`,
    `Safety: network=off | devices=off | credentials=none | dispatched_actions=${dispatchedActions}`,
    `Arrival: context=${arrival.includes("arrival-context-opened") ? "opened" : "missing"} | resident_primary=${result.final_state.presence.resident_primary} | security=${result.final_state.security_panel} | exterior_light=${result.final_state.exterior_light}`,
    `Resilience: alerts=${result.metrics.alerts} | deduplicated=${result.metrics.deduplicated} | stale_rejected=${result.metrics.stale_rejected} | restart_restores=${result.metrics.restart_restores} | recoveries=${result.metrics.recoveries}`,
    `Health: storage=${result.final_state.storage} | internet=${result.final_state.internet} | zigbee=${result.final_state.zigbee} | active_alerts=${result.active_alerts.length}`,
    "Evidence:",
    `- arrival coordination: ${arrival.join(" -> ")}`,
    `- infrastructure degradation: ${degradations.join("; ")}`,
    `- deduplication: ${observations(result, "-alert-deduplicated").join("; ")}`,
    `- stale/out-of-order: ${observations(result, "-stale-event-rejected").join("; ")}`,
    `- restart safety: ${observations(result, "restart-state-restored").join("; ")}`,
    `- recovery: ${recovered.join("; ")}`,
  ].join("\n");
}
