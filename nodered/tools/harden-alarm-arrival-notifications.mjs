#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const required = (id) => {
  const node = byId.get(id);
  if (!node) throw new Error(`missing node ${id}`);
  return node;
};

const TAB = "1f468eaeef0733dd";
const PREPARE = "88bf3513a44e58e6";
const PRIMARY = "3b95712a74512929";
const SECONDARY = "370622ddaaf3fcab";
const CATCH = "7a19b058661ba5f8";
const DEBUG = "694a63ad7980fa81";
const ACK = "alarm_arrival_notification_ack_v1";
const FAILURE = "alarm_arrival_notification_failure_v1";
const GROUP = "alarm_arrival_full_flow_group";

required(TAB).info = "Solicita confirmação por notificação acionável antes de desarmar o alarme quando resident_primary, resident_secondary ou o vehicle_primary estão chegando. Testes percorrem validação, pendência e confirmação, mas simulam toda interação mobile e terminam em dry-run sem notificação nem desarme.\n\nv11: produção preserva pendência e cooldown somente após o Home Assistant aceitar ao menos uma notificação; chamadas ficam enfileiradas durante reconexão.";

required(PREPARE).func = String.raw`const COOLDOWN_MS = 60 * 1000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const DELIVERY_WINDOW_MS = 30 * 1000;
const LAST_REQUEST_KEY = "alarm_arrival_last_confirmation_at";
const PENDING_KEY = "alarm_arrival_pending_confirmation";
const INFLIGHT_KEY = "alarm_arrival_confirmation_inflight";

const now = Date.now();
const lastRequest = Number(flow.get(LAST_REQUEST_KEY) || 0);
let pending = flow.get(PENDING_KEY);
let inflight = flow.get(INFLIGHT_KEY);

if (pending && (!Number.isFinite(Number(pending.expiresAt)) || Number(pending.expiresAt) <= now)) {
    flow.set(PENDING_KEY, null);
    pending = null;
}
if (inflight && (!Number.isFinite(Number(inflight.expiresAt)) || Number(inflight.expiresAt) <= now)) {
    flow.set(INFLIGHT_KEY, null);
    inflight = null;
}

if (
    pending?.expiresAt > now ||
    inflight?.expiresAt > now ||
    (Number.isFinite(lastRequest) && lastRequest > 0 && lastRequest <= now + 60 * 1000 && now - lastRequest < COOLDOWN_MS)
) {
    node.status({ fill: "grey", shape: "ring", text: "confirmacao real ja pendente" });
    return null;
}

const token = (now.toString(36) + "_" + Math.random().toString(36).slice(2, 10)).toUpperCase();
const confirmAction = "ALARME_DESARMAR_" + token;
const cancelAction = "ALARME_MANTER_ARMADO_" + token;
const candidate = {
    version: 1,
    deliveryId: token,
    confirmAction,
    cancelAction,
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    source: msg.arrival_source,
    stage: msg.arrival_stage,
    refreshCycleId: msg.payload?.refresh_cycle_id ?? null
};

flow.set(INFLIGHT_KEY, { deliveryId: token, expiresAt: now + DELIVERY_WINDOW_MS });
msg.alarmConfirmationCandidate = candidate;
msg.confirm_action = confirmAction;
msg.cancel_action = cancelAction;
msg.confirm_action_title = "Desarmar";
msg.cancel_action_title = "Manter armado";
msg.notification_title = "Confirmar desarme do alarme";
msg.notification_tag = "alarm_arrival_confirmation_real";
msg.notification_message = (msg.arrival_source || "residente") + " está chegando. Deseja desarmar o alarme da casa?";

node.status({ fill: "yellow", shape: "dot", text: "enviando confirmacao real" });
return msg;`;

for (const id of [PRIMARY, SECONDARY]) {
  const node = required(id);
  node.data = node.data.replace(/"action":"notify_[23]"/, '"action":"notify_actionable"');
  node.queue = "all";
  node.wires = [[ACK]];
}

required(CATCH).wires = [[FAILURE]];

const ackNode = {
  id: ACK,
  type: "function",
  z: TAB,
  g: GROUP,
  name: "Confirmar entrega da solicitacao",
  func: String.raw`const candidate = msg.alarmConfirmationCandidate;
if (!candidate || typeof candidate.deliveryId !== "string" || !Number.isFinite(Number(candidate.createdAt)) || !Number.isFinite(Number(candidate.expiresAt))) return null;
const PENDING_KEY = "alarm_arrival_pending_confirmation";
const LAST_REQUEST_KEY = "alarm_arrival_last_confirmation_at";
const INFLIGHT_KEY = "alarm_arrival_confirmation_inflight";
const existing = flow.get(PENDING_KEY);
if (!existing || existing.deliveryId === candidate.deliveryId || Number(existing.expiresAt || 0) <= Date.now()) {
    flow.set(PENDING_KEY, candidate);
    flow.set(LAST_REQUEST_KEY, Number(candidate.createdAt));
}
const inflight = flow.get(INFLIGHT_KEY);
if (inflight?.deliveryId === candidate.deliveryId) flow.set(INFLIGHT_KEY, null);
node.status({ fill: "green", shape: "dot", text: "entrega aceita pelo HA" });
return null;`,
  outputs: 0,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1900,
  y: 150,
  wires: [],
};

const failureNode = {
  id: FAILURE,
  type: "function",
  z: TAB,
  g: GROUP,
  name: "Registrar falha sem armar cooldown",
  func: String.raw`const source = String(msg.error?.source?.name ?? "notificacao").replace(/[^a-zA-Z0-9 _-]/g, "");
const detail = String(msg.error?.message ?? "erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 240);
node.error("alarm_arrival_notification_failed source=" + source + " message=" + detail);
node.status({ fill: "red", shape: "ring", text: "entrega falhou; sem cooldown" });
return msg;`,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1510,
  y: 320,
  wires: [[DEBUG]],
};

const replacements = new Map([[ACK, ackNode], [FAILURE, failureNode]]);
for (const [id, replacement] of replacements) {
  const index = flows.findIndex((node) => node.id === id);
  if (index >= 0) flows[index] = replacement;
  else flows.push(replacement);
}

fs.writeFileSync(flowUrl, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Hardened alarm arrival notification delivery.");
