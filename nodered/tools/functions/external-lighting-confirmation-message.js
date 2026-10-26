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
// An unavailable/unknown/missing/stale report is inconclusive, not a failed light.
const actionable = failed.filter(d => d.reason === 'mismatch');
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
const actionableSignature = actionable.map(d => `${d.id}:${d.reason}:${d.state}`).join('|');
// Only a fresh on/off mismatch opens an incident. Migrate known mismatch
// signatures, but never turn legacy unavailable/stale notices into recoveries.
const previousIncident = previous?.expected === expected && (previous?.version >= 3
    ? previous.incident_open === true && previous.incident_kind === 'fresh_mismatch'
    : previous?.failed === true && previous.signature?.split('|').some(item => /:mismatch:(on|off)$/.test(item)));
const signature = actionableSignature || (failed.length && previousIncident ? previous.signature : '');
const incidentOpen = actionable.length > 0 || failed.length > 0 && previousIncident === true;
const current = { issued_at: issuedAt, expected, failed: actionable.length > 0, signature,
    incident_open: incidentOpen, incident_kind: incidentOpen ? 'fresh_mismatch' : null,
    awaiting_fresh_report: failed.length > 0, observed_at: now, version: 3 };
if (testMode) flow.set(key, current); else flow.set(key, current, 'persistent');
// Persistent lifecycle: startup alone never emits a recovery. A change of intention
// supersedes the old incident instead of claiming its original command succeeded.
if (matching && failed.length) return [null, null];
const recovered = !failed.length && previousIncident === true;
const duplicate = previous?.expected === expected && previous?.signature === signature &&
    (actionable.length ? previousIncident === true : previous?.failed === current.failed);
if (actionable.length && !duplicate || recovered) {
    const intention = expected === 'on' ? 'ligar' : 'desligar';
    const detail = actionable.map(d => `${d.label}: esperado ${expected}, encontrado ${d.state} (${d.reason})`).join('; ');
    const guidance = 'Uma leitura válida posterior ao comando difere do esperado; verifique o dispositivo.';
    const message = failed.length
        ? `Iluminação externa: não foi possível confirmar ${intention}. ${detail}. ${guidance} O comando não foi repetido.`
        : `Iluminação externa: novos estados de todos os destinos confirmam ${intention}. Isso confirma o estado informado pelos dispositivos, não a emissão de luz.`;
    const alertMsg = { ...msg, _global_observer_test: testMode,
        payload: { test_mode: testMode, observer_kind: 'external_lighting_confirmation',
            incident_key: 'exterior_light', recovery: recovered, mobile_notification: true },
        alert: { title: recovered ? 'Iluminação externa confirmada' : 'Iluminação externa com estado diferente', message } };
    return [null, alertMsg];
}
if (failed.length || duplicate || msg.source === 'sunrise') return [null, null];
if (testMode) return [null, { ...msg, _global_observer_test: true, payload: { test_mode: true, observer_kind: 'external_lighting_confirmation', simulated: true, dispatched: false } }];
msg.notify_text = msg.notify_success || 'O estado informado da iluminação externa foi confirmado';
return [msg, null];
