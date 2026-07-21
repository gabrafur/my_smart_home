#!/usr/bin/env node
// Reescreve a aba "garagem" para acionar o rele Zigbee local
// (rele_acionador_portao, TS0001) como uma BOTOEIRA MOMENTANEA, no lugar da
// antiga cena Tuya de nuvem (script.portao_garagem_acionar).
//
// Comportamento de botoeira de campainha:
//  - o gatilho (botao fisico / app) ja passa pela funcao de debounce existente
//    ("normalizar clique e evitar duplicado", 900ms);
//  - o rele recebe um pulso via comando Zigbee onWithTimedOff (on_time), ou seja
//    ele LIGA e se DESLIGA sozinho no proprio hardware apos 1s (o contato nunca
//    fica preso mesmo se o Node-RED/rede cair);
//  - uma rede de seguranca publica um OFF ~2s depois, caso algum firmware ignore
//    o on_time.
//
// Idempotente: se os nos ja existirem, nao duplica.
// Uso: node tools/install-garage-relay-botoeira.mjs   (a partir de nodered/)

import { readFileSync, writeFileSync } from 'node:fs';

const FLOWS = new URL('../flows.json', import.meta.url).pathname;
// flows.json e' de outro dono (node-red); geramos o resultado num arquivo de
// saida (argv[2]) e depois ele e' escrito dentro do container.
const OUT = process.argv[2] || `${FLOWS}.new`;
const TAB = '29d64664bf8cbde8';               // aba "garagem"
const BROKER = '721c47f31046b8bc';            // broker Zigbee2MQTT
const NORMALIZAR = 'gar_portao_normalizar_click';
const RELAY_SET_TOPIC = 'zigbee2mqtt/rele_acionador_portao/set';

// nos da antiga cena de nuvem a remover (acionador + tratamento de erro/retry)
const CLOUD_NODES = [
  '10d528954a2d5cae',        // api-call-service: acionar_portao_garagem (cena)
  'gar_portao_error_catch',
  'gar_portao_retry_decision',
  'gar_portao_retry_delay',
  'gar_portao_error_notify',
];

const flows = JSON.parse(readFileSync(FLOWS, 'utf8'));

if (flows.some((n) => n.id === 'gar_relay_pulse_on')) {
  console.log('Nada a fazer: nos do rele ja existem (idempotente).');
  process.exit(0);
}

const normalizar = flows.find((n) => n.id === NORMALIZAR);
if (!normalizar) throw new Error(`no ${NORMALIZAR} nao encontrado`);

// 1) repontar o gatilho debounced para o novo pulso do rele
normalizar.wires = [['gar_relay_pulse_on']];

// 2) remover os nos da antiga cena de nuvem
let out = flows.filter((n) => !CLOUD_NODES.includes(n.id));

// 3) adicionar os novos nos do rele
const novos = [
  {
    id: 'gar_relay_pulse_on',
    type: 'function',
    z: TAB,
    name: 'botoeira: pulso momentaneo no rele',
    func:
      "// Botoeira de campainha: pulso momentaneo no rele_acionador_portao.\n" +
      "// onWithTimedOff (on_time) -> o proprio rele desliga sozinho apos 1s,\n" +
      "// entao mesmo que o Node-RED/rede caia o contato nunca fica preso.\n" +
      `msg.topic = '${RELAY_SET_TOPIC}';\n` +
      "msg.payload = JSON.stringify({ state: 'ON', on_time: 1, off_wait_time: 0 });\n" +
      "return msg;",
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 640,
    y: 120,
    wires: [['gar_relay_mqtt_out', 'gar_relay_safety_delay']],
  },
  {
    id: 'gar_relay_mqtt_out',
    type: 'mqtt out',
    z: TAB,
    name: 'rele_acionador_portao set',
    topic: '',
    qos: '',
    retain: '',
    respTopic: '',
    contentType: '',
    userProps: '',
    correl: '',
    expiry: '',
    broker: BROKER,
    x: 960,
    y: 120,
    wires: [],
  },
  {
    id: 'gar_relay_safety_delay',
    type: 'delay',
    z: TAB,
    name: 'seguranca: garantir OFF apos 2s',
    pauseType: 'delay',
    timeout: '2',
    timeoutUnits: 'seconds',
    rate: '1',
    nbRateUnits: '1',
    rateUnits: 'second',
    randomFirst: '1',
    randomLast: '5',
    randomUnits: 'seconds',
    drop: false,
    allowrate: false,
    outputs: 1,
    x: 660,
    y: 200,
    wires: [['gar_relay_pulse_off']],
  },
  {
    id: 'gar_relay_pulse_off',
    type: 'function',
    z: TAB,
    name: 'seguranca: garantir rele desligado',
    func:
      "// Rede de seguranca: garante OFF caso algum firmware ignore o on_time.\n" +
      `msg.topic = '${RELAY_SET_TOPIC}';\n` +
      "msg.payload = JSON.stringify({ state: 'OFF' });\n" +
      "return msg;",
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 940,
    y: 200,
    wires: [['gar_relay_mqtt_out']],
  },
];

out = out.concat(novos);

writeFileSync(OUT, JSON.stringify(out, null, 4) + '\n');
console.log('escrito em:', OUT);
console.log(`OK: removidos ${CLOUD_NODES.length} nos de nuvem, adicionados ${novos.length} nos do rele.`);
console.log('Total de nos agora:', out.length);
