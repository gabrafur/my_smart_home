#!/usr/bin/env node
// O rele TS0001 (_TZ3000_c8wtsv3p) NAO honra onWithTimedOff (on_time) — ele so
// expoe State liga/desliga. Entao o "pulso de botoeira" passa a ser feito por
// SOFTWARE no fluxo: liga -> espera ~0.7s -> desliga.
//
// Uso: node tools/fix-garage-relay-software-pulse.mjs [saida.json]

import { readFileSync, writeFileSync } from 'node:fs';

const FLOWS = new URL('../flows.json', import.meta.url).pathname;
const OUT = process.argv[2] || `${FLOWS}.new`;
const TOPIC = 'zigbee2mqtt/rele_acionador_portao/set';

const flows = JSON.parse(readFileSync(FLOWS, 'utf8'));
const on = flows.find((n) => n.id === 'gar_relay_pulse_on');
const delay = flows.find((n) => n.id === 'gar_relay_safety_delay');
const off = flows.find((n) => n.id === 'gar_relay_pulse_off');
if (!on || !delay || !off) throw new Error('nos do rele nao encontrados; rode install-garage-relay-botoeira.mjs antes');

on.name = 'botoeira: liga o rele (inicio do pulso)';
on.func =
  "// Botoeira: fecha o contato. O TS0001 nao honra on_time, entao o pulso e'\n" +
  "// feito por software: este no liga, o delay+no seguinte desligam.\n" +
  `msg.topic = '${TOPIC}';\n` +
  "msg.payload = JSON.stringify({ state: 'ON' });\n" +
  "return msg;";

delay.name = 'pulso: manter fechado ~0.7s';
delay.pauseType = 'delay';
delay.timeout = '700';
delay.timeoutUnits = 'milliseconds';

off.name = 'botoeira: solta o contato (fim do pulso)';
off.func =
  "// Fim do pulso: abre o contato.\n" +
  `msg.topic = '${TOPIC}';\n` +
  "msg.payload = JSON.stringify({ state: 'OFF' });\n" +
  "return msg;";

writeFileSync(OUT, JSON.stringify(flows, null, 4) + '\n');
console.log('escrito em:', OUT);
console.log('pulso: liga -> 700ms -> desliga (comandos simples ON/OFF)');
