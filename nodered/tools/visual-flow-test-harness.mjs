export function runPeopleVisual(call, message) {
  let msg = call("people_location_observation_v1", message);
  msg = call("people_location_select_v1", msg);
  msg = call("people_location_classify_near_home_v1", msg);
  msg = call("people_visual_test_adapter", msg);
  msg = call("people_visual_normalize", msg);
  msg = call("people_visual_state_load", msg);
  msg = call("people_visual_facts", msg);
  const data = msg._people;
  const facts = data.facts;
  const arrival = data.is_location_event && facts.source_ready && facts.trigger_prev_valid &&
    !facts.departure && !facts.stale_catchup && facts.external_cycle_confirmed &&
    (facts.approach_entry || facts.near_home);
  const recovery = data.is_location_event && facts.source_ready && facts.trigger_prev_unavailable &&
    data.trigger_state === "near_home" && data.people[data.source]?.current_home !== true &&
    facts.external_cycle_confirmed;
  if (arrival) {
    msg = call("people_visual_arrival_gate", msg);
    msg = call("people_visual_arrival_dedupe", msg);
  } else if (recovery) {
    msg = call("people_visual_recovery_build", msg);
    msg = call("people_visual_recovery_dedupe", msg);
  } else if (data.is_location_event && facts.directional_candidate) {
    msg = call("people_visual_blocked_build", msg);
  }
  return call("554cb653b2fa4504", msg);
}

export function runVehicleVisual(call, message) {
  let msg = call("vehicle_primary_classify_near_home_v1", message);
  msg = call("vehicle_visual_test_adapter", msg);
  msg = call("vehicle_visual_normalize", msg);
  msg = call("vehicle_visual_movement", msg);
  msg = call("vehicle_visual_state_load", msg);
  const data = msg._vehicle;
  const near = data.location.ready && ((data.location.gate_distance_m !== null &&
    data.location.gate_distance_m <= data.policy.near_home_radius_m) ||
    (data.location.distance_m !== null && data.location.distance_m <= data.policy.near_home_radius_m) ||
    (data.location.distance_m === null && data.location.gate_distance_m === null && data.location.state === "home"));
  const away = data.location.ready && (data.location.distance_m !== null
    ? data.location.distance_m > data.policy.home_radius_m : data.location.state === "not_home");
  if (data.engine_on) {
    data.in_use = true;
    data.in_use_reason = "known_engine_on";
  } else if (data.engine_off) {
    data.in_use = false;
    data.in_use_reason = "known_engine_off";
  } else if (data.recovery.in_use === true && away) {
    data.in_use = true;
    data.in_use_reason = "persisted_trip_revalidated_by_fresh_away_location";
  } else if (data.lock_fresh && data.unlocked && near) {
    data.in_use = false;
    data.in_use_reason = "fresh_home_unlocked_engine_pending";
  } else {
    data.in_use = null;
    data.in_use_reason = "insufficient_current_evidence";
  }
  msg = call("vehicle_visual_arrival_facts", msg);
  if (msg._vehicle.facts.arrival_eligible) {
    msg = call("vehicle_visual_arrival_build", msg);
    msg = call("vehicle_visual_arrival_dedupe", msg);
  } else if (msg._vehicle.facts.blocked_candidate) {
    msg = call("vehicle_visual_blocked_build", msg);
  }
  msg = call("vehicle_visual_state_finalize", msg);
  msg = call("vehicle_visual_evidence_read", msg);
  if (msg._vehicle.evidence.awaiting && msg._vehicle.evidence.confirmed) {
    msg = call("vehicle_visual_evidence_confirm", msg);
  }
  return call("092625f2eb5cc156", msg);
}

export function runVehicleRefreshVisual(call, message) {
  let msg = call("vehicle_visual_refresh_load", message);
  if (!msg) return null;
  msg = call("vehicle_visual_refresh_facts", msg);
  const data = msg._refresh;
  if (data.flags.cache_active) {
    data.suppress_reason = "cache_probe_in_flight";
    msg = call("vehicle_visual_refresh_suppress_cache_active", msg);
  } else if (data.flags.cache_settling) {
    data.suppress_reason = "cache_probe_settling";
    msg = call("vehicle_visual_refresh_suppress_cache_settle", msg);
  } else if (data.flags.request_active) {
    data.suppress_reason = "in_flight";
    msg = call("vehicle_visual_refresh_suppress_request_active", msg);
  } else if (data.flags.departure_covered) {
    msg = call("vehicle_visual_refresh_departure_done", msg);
  } else if (!data.flags.enabled) {
    msg = call("vehicle_visual_refresh_wait_location", msg);
  } else if (data.flags.deadline_blocked) {
    data.suppress_reason = data.flags.waiting_evidence ? "backoff" : "minimum_interval";
    msg = call(data.flags.waiting_evidence
      ? "vehicle_visual_refresh_suppress_backoff" : "vehicle_visual_refresh_suppress_minimum", msg);
  } else if (data.flags.cache_probe_needed) {
    msg = call("vehicle_visual_refresh_cache_build", msg);
  } else {
    msg = call("vehicle_visual_refresh_dispatch_build", msg);
  }
  return call("b33e117e55bdb5ed", msg);
}

export function runSecurityArrivalVisual(call, message) {
  let msg = call("security_visual_arrival_facts", message);
  if (!msg) return null;
  if (!msg._light_arrival.direction_valid) {
    msg = call("security_light_arrival_direction_blocked_v1", msg);
  } else {
    msg = call("security_visual_arrival_pending", msg);
    const data = msg._light_arrival;
    if (data.logic_ready) msg = call("security_visual_arrival_ready", msg);
    else if (data.recovery_needed && data.recovery_allowed) msg = call("security_visual_arrival_recovery", msg);
    else if (data.recovery_needed) msg = call("security_visual_arrival_throttled", msg);
    else msg = call("security_visual_arrival_pending_only", msg);
  }
  return call("62f77a1ad440639d", msg);
}

export function runSecurityContextVisual(call, message) {
  let msg = call("security_visual_context_cache", message);
  if (!msg) return null;
  msg = call("security_visual_pending_validate", msg);
  if (msg._light_context.replay_ready) msg = call("security_visual_replay_build", msg);
  return call("48a5f40d806f6950", msg);
}

export function runSecurityReconcileVisual(call, message) {
  let msg = call("security_visual_lifecycle_load", message);
  if (!msg) return null;
  msg = call("security_visual_physical_apply", msg);
  msg = call("security_visual_recovery_facts", msg);
  if (!msg._light_reconcile.recovery_needed) return null;
  msg = call("security_visual_recovery_build", msg);
  return call("a0a4977052d1ce06", msg);
}

export function ensureArrivalContextPolicy(call) {
  let msg = call("arrival_context_policy_validate", {
    payload: { inflight_timeout_s: 10, future_tolerance_s: 60 }
  });
  call("arrival_context_policy_store", msg);
}

export function runArrivalContextVisual(call, message) {
  const kind = message.payload?.kind;
  if (kind === "refresh_tick") {
    let msg = call("arrival_context_cycle_policy_load", message);
    if (msg.policy_available !== true) return null;
    msg = call("arrival_context_cycle_read", msg);
    if (msg.context_cycle_inflight) {
      if (msg.context_force_recovery) call("arrival_context_cycle_promote", msg);
      return null;
    }
    return [call("arrival_context_cycle_start", msg), null, null];
  }
  if (!["people_context", "vehicle_primary_context"].includes(kind)) return null;
  let msg = call("arrival_context_snapshot_policy_load", message);
  if (msg.policy_available !== true) return null;
  msg = call("arrival_context_snapshot_read", msg);
  if (msg.context_snapshot_valid !== true) return null;
  if (msg.context_is_future) {
    msg.context_snapshot_action = "reject";
    msg.context_rejected_reason = "future_timestamp";
  } else if (msg.context_is_out_of_order) {
    msg.context_snapshot_action = "reject";
    msg.context_rejected_reason = "out_of_order";
  } else if (msg.context_is_newer || msg.context_same_changed) {
    msg.context_snapshot_action = "accept";
  } else if (msg.context_missing_timestamp) {
    msg.context_snapshot_action = "reject";
    msg.context_rejected_reason = "missing_timestamp";
  } else {
    msg.context_snapshot_action = "reject";
    msg.context_rejected_reason = "duplicate";
  }
  msg = call("arrival_context_cache_mutate", msg);
  msg = call("arrival_context_departure_read", msg);
  const departure = msg.context_domain === "people" && msg.context_snapshot_accepted &&
    ["resident_primary", "resident_secondary"].includes(msg.departure_source) &&
    msg.payload.trigger_prev_state === "home" && ["near_home", "not_home"].includes(msg.payload.trigger_state) &&
    msg.departure_position?.ready === true && msg.payload.context.best_location_away === true &&
    msg.departure_previous_signature !== msg.departure_signature;
  let command = null;
  if (departure) {
    const outputs = call("arrival_context_departure_build", msg);
    command = outputs[0];
    msg = outputs[1];
  }
  msg = call("arrival_context_pending_read", msg);
  let paired = null;
  if (msg.context_cycle_match) {
    msg = call("arrival_context_pending_update", msg);
    if (msg.context_both_received && !msg.context_already_emitted) {
      msg = call("arrival_context_mark_emitted", msg);
      if (!msg.context_departure_selected) {
        msg.context_people_recovery_needed = msg.context_pending.people_ready !== true;
        msg.context_contexts_ready = msg.context_pending.people_ready === true &&
          msg.context_pending.vehicle_primary_ready === true;
        msg.context_recovery_needed = msg.context_pending.vehicle_primary_ready !== true ||
          msg.context_pending.force_recovery === true;
        msg.context_recovery_reason = msg.context_pending.request_reason ||
          (msg.context_recovery_needed ? "vehicle_readiness_recovery_needed" :
            msg.context_people_recovery_needed ? "people_location_recovery_only" : "paired_ready_snapshots");
        paired = call("arrival_context_refresh_build", msg);
      }
    }
  }
  return command || paired ? [command, paired, null] : null;
}
