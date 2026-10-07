const expected = msg.expected_state || msg.payload?.expected_state;
const labels = {
    lampada_varanda: 'varanda',
    lampadas_garagem: 'garagem',
    refletores_jardim: 'jardim'
};
const states = {
    lampada_varanda: msg.payload?.lampada_varanda,
    lampadas_garagem: msg.payload?.lampadas_garagem,
    refletores_jardim: msg.payload?.refletores_jardim
};
const networkFailureStates = new Set([undefined, null, '', 'unknown', 'unavailable']);
const unavailable = Object.entries(states)
    .filter(([, state]) => networkFailureStates.has(state))
    .map(([entity]) => labels[entity]);

if (flow.get('external_lighting_zigbee_state') === 'offline' || unavailable.length > 0) {
    msg.zigbee_error = true;
    const affected = unavailable.length > 0 ? ` Sem comunicação com: ${unavailable.join(', ')}.` : '';
    msg.notify_text = `Erro na rede Zigbee.${affected} O comando da iluminação externa não será repetido.`;
    return msg;
}

const failed = Object.entries(states)
    .filter(([, state]) => state !== expected)
    .map(([entity, state]) => `${labels[entity]} ${state}`);

if (failed.length === 0) {
    if (msg.source === 'sunrise') {
        node.status({ fill: 'green', shape: 'dot', text: 'amanhecer confirmado; aviso silencioso' });
        return null;
    }
    msg.notify_text = msg.notify_success || msg.notify_text;
    return msg;
}

const expectedText = expected === 'on' ? 'ligada' : 'desligada';
msg.notify_text = `Erro ao acionar a iluminação externa. Esperado: ${expectedText}. Estado atual: ${failed.join(', ')}. O comando não será repetido.`;
return msg;
