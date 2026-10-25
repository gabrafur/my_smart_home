// Matching cached states are not a fresh command acknowledgement or a failure.
const testMode = msg._external_command?.test_mode === true || msg._external_lighting_test === true;
const expected = msg.expected_state || msg.payload?.expected_state;
const issuedAt = Number(msg.external_issued_at);
const now = Date.now();
const labels = { lampada_varanda: 'varanda', lampadas_garagem: 'garagem',
    refletores_jardim: 'jardim', abajour_sala_de_estar: 'abajur' };
const observations = msg.payload?.observations ?? {};
if (!['on', 'off'].includes(expected) || !Number.isFinite(issuedAt) || issuedAt <= 0 || issuedAt > now) {
    node.error('external_lighting_confirmation_invalid_context', { _msgid: msg._msgid, _global_observer_test: testMode, payload: { test_mode: testMode } });
    return [null, null];
}
const devices = Object.entries(labels).map(([id, label]) => {
    const report = observations[id];
    const state = ['on', 'off', 'unknown', 'unavailable'].includes(report?.state) ? report.state : 'unknown';
    const at = Date.parse(report?.observed_at);
    const reason = !report ? 'missing' : state === 'unavailable' ? 'unavailable' :
        state === 'unknown' ? 'unknown' : !Number.isFinite(at) || at < issuedAt || at > now ? 'stale' :
        state !== expected ? 'mismatch' : 'confirmed';
    return { id, label, expected, state, observed_at: Number.isFinite(at) ? at : null, reason };
});
const failed = devices.filter(d => d.reason !== 'confirmed');
const matching = devices.every(d => d.state === expected);
const unresolved = failed.filter(d => d.state !== expected);
msg.external_confirmation = { issued_at: issuedAt, observed_at: now, devices,
    status: failed.length ? 'unconfirmed' : 'confirmed', matching_reported_states: matching,
    coverage: ['ha_entity_report_after_command', 'not_physical_light_or_human_ack'] };
const key = testMode ? 'external_confirmation_incident_v1__test' : 'external_confirmation_incident_v1';
const previous = testMode ? flow.get(key) : flow.get(key, 'persistent');
if (previous?.issued_at > issuedAt) return [null, null];
if (!failed.length) {
    if (testMode) flow.set('external_pending_v1__test', null);
    else flow.set('external_pending_v1', null, 'persistent');
}
const signature = unresolved.map(d => `${d.id}:${d.reason}:${d.state}`).join('|');
// Preserve a genuine prior confirmation incident, but not the legacy false alarm
// whose entire signature was matching cached states. Never announce recovery
// from a cached match alone.
const previousIncident = previous?.expected === expected && (previous?.incident_open === true ||
    previous?.version === 1 && previous.failed === true &&
    previous.signature?.split('|').some(item => !item.endsWith(`:stale:${expected}`)));
const current = { issued_at: issuedAt, expected, failed: unresolved.length > 0, signature,
    incident_open: unresolved.length > 0 || failed.length > 0 && previousIncident === true,
    awaiting_fresh_report: failed.length > 0, observed_at: now, version: 2 };
if (testMode) flow.set(key, current); else flow.set(key, current, 'persistent');
// Persistent lifecycle: startup alone never emits a recovery. A change of intention
// supersedes the old incident instead of claiming its original command succeeded.
if (matching && failed.length) return [null, null];
const recovered = !failed.length && previousIncident === true;
const duplicate = previous?.expected === expected && previous?.signature === signature && previous?.failed === current.failed;
if (unresolved.length && !duplicate || recovered) {
    const intention = expected === 'on' ? 'ligar' : 'desligar';
    const detail = unresolved.map(d => `${d.label}: esperado ${expected}, encontrado ${d.state} (${d.reason})`).join('; ');
    const mismatch = unresolved.some(d => d.reason === 'mismatch');
    const guidance = mismatch ? 'Uma leitura posterior ao comando difere do esperado; verifique o dispositivo.' :
        'Falta uma leitura válida dos destinos indicados; verifique a integração no Home Assistant.';
    const message = failed.length
        ? `Iluminação externa: não foi possível confirmar ${intention}. ${detail}. ${guidance} O comando não foi repetido.`
        : `Iluminação externa: novos estados de todos os destinos confirmam ${intention}. Isso confirma o estado informado pelos dispositivos, não a emissão de luz.`;
    const alertMsg = { ...msg, _global_observer_test: testMode,
        payload: { test_mode: testMode, observer_kind: 'external_lighting_confirmation',
            incident_key: 'exterior_light', recovery: recovered, mobile_notification: true },
        alert: { title: recovered ? 'Iluminação externa confirmada' : mismatch ? 'Iluminação externa com estado diferente' : 'Confirmação da iluminação indisponível', message } };
    return [null, alertMsg];
}
if (failed.length || duplicate || msg.source === 'sunrise') return [null, null];
if (testMode) return [null, { ...msg, _global_observer_test: true, payload: { test_mode: true, observer_kind: 'external_lighting_confirmation', simulated: true, dispatched: false } }];
msg.notify_text = msg.notify_success || 'O estado informado da iluminação externa foi confirmado';
return [msg, null];
