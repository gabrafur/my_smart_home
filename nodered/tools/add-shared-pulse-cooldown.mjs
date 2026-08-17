#!/usr/bin/env node
// Cooldown de pulso COMPARTILHADO entre as duas fontes de acionamento do portao.
//
// Existem dois caminhos independentes que pulsam rele_acionador_portao:
//   1. este fluxo (botao Zigbee fisico botao_portao_garagem);
//   2. button.acionar_portao_da_garagem / script.portao_garagem_pulso no HA.
//
// O lado do HA ja enxerga os pulsos daqui (uma automacao carimba o cooldown a
// cada off->on do rele). O contrario nao era verdade: um clique no botao do
// dashboard seguido de um aperto no botao fisico mandava um SEGUNDO pulso ao
// motor. Cada ON e' uma acao fisica real, entao isso importa.
//
// Correcao: este fluxo passa a observar o proprio MQTT e a carimbar o instante
// de QUALQUER pulso, venha de onde vier. Sem dependencia do HA e sem latencia
// extra — que e' justamente o motivo de o botao fisico nao passar pelo HA.
//
// Assina dois topicos, de proposito:
//   - .../set   -> ve o comando no instante em que ele e' publicado (protecao
//                  mais apertada; pega o ON do HA em milissegundos);
//   - o topico de estado -> pega qualquer pulso, inclusive um comandado fora
//                  desses dois caminhos (Developer Tools, mosquitto_pub...).
//
// Uso: node tools/add-shared-pulse-cooldown.mjs [saida.json]

import { readFileSync, writeFileSync } from 'node:fs';

const FLOWS = new URL('../flows.json', import.meta.url).pathname;
const OUT = process.argv[2] || `${FLOWS}.new`;

const TAB = '29d64664bf8cbde8';
const BROKER = '721c47f31046b8bc';
const SET_TOPIC = '${BINDING_GARAGE_GATE_COMMAND_TOPIC}';
const STATE_TOPIC = '${BINDING_GARAGE_GATE_STATE_TOPIC}';

// Mesma janela do script.portao_garagem_pulso no HA (variavel cooldown_s: 3).
// Mudou aqui? Mude la tambem, senao as duas pontas divergem.
const COOLDOWN_MS = 3000;
// Coalesce: o ON do /set e o ON do topico de estado sao o MESMO pulso chegando
// duas vezes. Sinais de ON dentro desta janela contam como um so.
const SAME_PULSE_MS = 500;

const flows = JSON.parse(readFileSync(FLOWS, 'utf8'));

const normalizar = flows.find((n) => n.id === 'gar_portao_normalizar_click');
if (!normalizar) throw new Error('no gar_portao_normalizar_click nao encontrado');

// --- 1. observador: carimba o instante de qualquer pulso ---------------------

const watchSet = {
    id: 'gar_pulse_watch_set_in',
    type: 'mqtt in',
    z: TAB,
    name: 'rele: comando (qualquer origem)',
    topic: SET_TOPIC,
    qos: '2',
    datatype: 'auto-detect',
    broker: BROKER,
    nl: false,
    rap: true,
    rh: 0,
    inputs: 0,
    x: 280,
    y: 300,
    wires: [['gar_pulse_watch_stamp']],
};

const watchState = {
    id: 'gar_pulse_watch_state_in',
    type: 'mqtt in',
    z: TAB,
    name: 'rele: estado reportado',
    topic: STATE_TOPIC,
    qos: '2',
    datatype: 'auto-detect',
    broker: BROKER,
    nl: false,
    rap: true,
    rh: 0,
    inputs: 0,
    x: 270,
    y: 360,
    wires: [['gar_pulse_watch_stamp']],
};

const stamp = {
    id: 'gar_pulse_watch_stamp',
    type: 'function',
    z: TAB,
    name: 'carimbar pulso (arma cooldown compartilhado)',
    func: [
        "// Carimba o instante de qualquer pulso do rele, venha do HA, deste",
        "// fluxo ou de um comando manual. Nao publica nada — so registra.",
        `const samePulseMs = ${SAME_PULSE_MS};`,
        "const now = Date.now();",
        "",
        "// O payload pode ser 'ON' cru (o HA publica assim, via switch.turn_on)",
        "// ou {\"state\":\"ON\"} (formato deste fluxo e do topico de estado).",
        "let state;",
        "if (typeof msg.payload === 'string') {",
        "    state = msg.payload;",
        "} else if (msg.payload && typeof msg.payload === 'object') {",
        "    state = msg.payload.state;",
        "}",
        "",
        "if (String(state).toUpperCase() !== 'ON') {",
        "    return null;",
        "}",
        "",
        "// O mesmo pulso chega duas vezes (comando + estado). Conta uma so.",
        "const last = Number(flow.get('portao_garagem_last_pulse_ms') || 0);",
        "if (now - last < samePulseMs) {",
        "    return null;",
        "}",
        "",
        "flow.set('portao_garagem_last_pulse_ms', now);",
        "node.status({ fill: 'blue', shape: 'dot', text: 'pulso ' + new Date(now).toLocaleTimeString() });",
        "return null;",
    ].join('\n'),
    outputs: 0,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 640,
    y: 330,
    wires: [],
};

// --- 2. o normalizador passa a respeitar o cooldown compartilhado ------------

normalizar.name = 'normalizar clique (dedupe + cooldown compartilhado)';
normalizar.func = [
    "// Deixa passar no maximo um clique por vez, e so se nenhum pulso (deste",
    "// fluxo OU do botao do Home Assistant) tiver acontecido ha pouco.",
    "// Cada ON no rele e' uma acao fisica real no motor.",
    "const now = Date.now();",
    "// Retransmissao Zigbee do MESMO aperto (o botao publica em dois topicos).",
    "const dedupeMs = 900;",
    `// Janela morta apos um pulso de QUALQUER origem. Espelha cooldown_s do`,
    `// script.portao_garagem_pulso no HA — mantenha os dois iguais.`,
    `const cooldownMs = ${COOLDOWN_MS};`,
    "let action;",
    "",
    "if (typeof msg.payload === 'string') {",
    "    action = msg.payload;",
    "} else if (msg.payload && typeof msg.payload === 'object') {",
    "    action = msg.payload.action;",
    "}",
    "",
    "if (action !== 'single') {",
    "    return null;",
    "}",
    "",
    "const lastAccepted = Number(flow.get('portao_garagem_last_click_ms') || 0);",
    "if (now - lastAccepted < dedupeMs) {",
    "    return null;",
    "}",
    "",
    "// Cooldown compartilhado: carimbado pelo no 'carimbar pulso' a cada ON do",
    "// rele, inclusive os que vieram do botao do dashboard.",
    "const lastPulse = Number(flow.get('portao_garagem_last_pulse_ms') || 0);",
    "if (now - lastPulse < cooldownMs) {",
    "    node.status({ fill: 'yellow', shape: 'ring', text: 'clique ignorado (cooldown)' });",
    "    node.warn('portao: clique ignorado — pulso ha ' + (now - lastPulse) + 'ms (cooldown ' + cooldownMs + 'ms)');",
    "    return null;",
    "}",
    "",
    "flow.set('portao_garagem_last_click_ms', now);",
    "node.status({ fill: 'green', shape: 'dot', text: 'pulso ' + new Date(now).toLocaleTimeString() });",
    "msg.payload = {",
    "    action,",
    "    source_topic: msg.topic,",
    "    received_at: new Date(now).toISOString(),",
    "};",
    "return msg;",
].join('\n');

// --- 3. comentario na canvas -------------------------------------------------

const note = {
    id: 'gar_pulse_watch_note',
    type: 'comment',
    z: TAB,
    name: 'Cooldown compartilhado com o botao do Home Assistant',
    info: [
        'Duas fontes pulsam o mesmo rele:',
        '',
        '  - este fluxo (botao Zigbee fisico), publicando {"state":"ON"};',
        '  - button.acionar_portao_da_garagem no HA, publicando ON cru.',
        '',
        'Os nos abaixo observam o MQTT do rele e carimbam',
        'flow.portao_garagem_last_pulse_ms a cada ON, de qualquer origem. O',
        'normalizador de clique respeita essa janela, entao um pulso vindo do HA',
        'tambem bloqueia este fluxo (e nao so o contrario).',
        '',
        'A janela (3s) espelha cooldown_s de script.portao_garagem_pulso.',
        'Ver docs/PORTAO_GARAGEM_BOTAO_PULSO.md.',
    ].join('\n'),
    x: 340,
    y: 260,
    wires: [],
};

for (const id of [watchSet.id, watchState.id, stamp.id, note.id]) {
    if (flows.some((n) => n.id === id)) throw new Error(`no ${id} ja existe; nada a fazer`);
}

flows.push(note, watchSet, watchState, stamp);

writeFileSync(OUT, JSON.stringify(flows, null, 4) + '\n');
console.log('escrito em:', OUT);
console.log(`cooldown compartilhado: ${COOLDOWN_MS}ms (espelha cooldown_s=3 no HA)`);
