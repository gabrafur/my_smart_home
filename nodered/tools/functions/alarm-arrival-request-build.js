const now = msg.arrival_request.now;
flow.set("alarm_arrival_pending_confirmation", null);
flow.set("alarm_arrival_confirmation_inflight", null);
const token = (now.toString(36) + "_" + Math.random().toString(36).slice(2, 10)).toUpperCase();
const candidate = {
    version: 1, deliveryId: token,
    confirmAction: `ALARME_DESARMAR_${token}`, cancelAction: `ALARME_MANTER_ARMADO_${token}`,
    createdAt: now, expiresAt: now + msg.policy.confirmation_ttl_s * 1000,
    source: msg.arrival_source, stage: msg.arrival_stage,
    refreshCycleId: msg.payload?.refresh_cycle_id ?? null
};
flow.set("alarm_arrival_confirmation_inflight", { deliveryId: token, expiresAt: now + msg.policy.delivery_window_s * 1000 });
msg.alarmConfirmationCandidate = candidate;
msg.confirm_action = candidate.confirmAction;
msg.cancel_action = candidate.cancelAction;
msg.confirm_action_title = "Desarmar";
msg.cancel_action_title = "Manter armado";
msg.notification_title = "Confirmar desarme do alarme";
msg.notification_tag = "alarm_arrival_confirmation_real";
msg.notification_message = `${msg.arrival_source || "residente"} está perto de casa. Deseja desarmar o alarme da casa?`;
return msg;
