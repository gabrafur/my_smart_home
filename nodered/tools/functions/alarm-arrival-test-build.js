const { now, reset_at: resetAt } = msg.arrival_test;
const source = msg.arrival_source ?? msg.payload?.source ?? "manual";
const stage = msg.arrival_stage ?? msg.payload?.arrival_stage ?? "manual";
const testCase = msg._location_test_case ?? msg.payload?.test_case ?? "manual_notification_test";
const refreshCycleId = msg.payload?.refresh_cycle_id ?? null;
const createdAt = Math.max(now, resetAt + 1);
const token = (createdAt.toString(36) + "_" + Math.random().toString(36).slice(2, 10)).toUpperCase();
const pending = {
    version: 1, confirmAction: `ALARME_TESTE_CONFIRMAR_${token}`, cancelAction: `ALARME_TESTE_CANCELAR_${token}`,
    createdAt, expiresAt: createdAt + msg.policy.test_ttl_s * 1000, source, stage, testCase, refreshCycleId
};
flow.set("alarm_arrival_test_pending_confirmation", pending);
Object.assign(msg, {
    _location_test: true, _location_test_case: testCase, alarm_arrival_test: true,
    confirm_action: pending.confirmAction, cancel_action: pending.cancelAction,
    confirm_action_title: "Confirmar teste", cancel_action_title: "Cancelar teste",
    notification_title: "[TESTE] Confirmação do alarme", notification_tag: "alarm_arrival_confirmation_test",
    notification_message: `[TEST] ${source} está perto de casa (${stage}). Notificação e desarme serão simulados.`
});
return msg;
