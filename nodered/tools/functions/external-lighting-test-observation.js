if (msg._external_command?.test_mode !== true) return null;
const expected = msg.expected_state;
const observedAt = new Date().toISOString();
const ids = ['lampada_varanda', 'lampadas_garagem', 'refletores_jardim', 'abajour_sala_de_estar'];
msg.payload = { test_mode: true, observations: Object.fromEntries(ids.map(id => [id,
    msg._external_test_observations?.[id] ?? { state: expected, observed_at: observedAt }])) };
msg._external_lighting_test = true;
return msg;
