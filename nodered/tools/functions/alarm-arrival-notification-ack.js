const candidate = msg.alarmConfirmationCandidate;
if (!candidate || typeof candidate.deliveryId !== "string" || !Number.isFinite(Number(candidate.createdAt)) || !Number.isFinite(Number(candidate.expiresAt))) return null;
const existing = flow.get("alarm_arrival_pending_confirmation");
if (!existing || existing.deliveryId === candidate.deliveryId || Number(existing.expiresAt || 0) <= Number(msg.arrival_now ?? Date.now())) {
    flow.set("alarm_arrival_pending_confirmation", candidate);
    flow.set("alarm_arrival_last_confirmation_at", Number(candidate.createdAt));
}
const inflight = flow.get("alarm_arrival_confirmation_inflight");
if (inflight?.deliveryId === candidate.deliveryId) flow.set("alarm_arrival_confirmation_inflight", null);
node.status({ fill: "green", shape: "dot", text: "entrega aceita pelo HA" });
return null;
