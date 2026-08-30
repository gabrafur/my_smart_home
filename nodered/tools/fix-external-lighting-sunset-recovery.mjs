import fs from "node:fs";

const flowsPath = new URL("../flows.json", import.meta.url);
const issuesPath = new URL(
  "../node-red-contrib-home-assistant-websocket.json",
  import.meta.url,
);
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));

const tabId = "ce258dec9814b96b";
const haServerId = "4126427d5e161a03";
const sunsetCommandId = "943c87e6b17f0d68";
const alexaNotifyId = "9d81b75a18d482f1";

const removedIds = new Set([
  "ext_sunset_alarm_check",
  "ext_alarm_armed_off",
  "ext_alarm_armed_lighting_in",
  "alarm_armed_lighting_out",
  "alarm_real_change_filter",
  "e380ce19c7f96420",
]);

const managedIds = new Set([
  "ext_sunset_recovery_boot",
  "ext_sunset_recovery_sun_check",
  "ext_prepare_recovery_confirmation",
  "ext_send_recovery_mobile",
  "ext_commit_recovery_confirmation",
  "ext_recovery_notification_action",
  "ext_validate_recovery_confirmation",
  "ext_confirm_recovery_sun_check",
]);

const sunset = byId.get("24743bc9f254d1c1");
if (!sunset) throw new Error("External-lighting sunset node not found");
sunset.outputInitially = false;
sunset.wires = [[sunsetCommandId], []];

const lightTab = byId.get(tabId);
if (lightTab) {
  lightTab.info =
    "Controla a iluminação externa por comando manual e pôr do sol. Não consulta nem recebe eventos do fluxo Moni Mobile.";
}

const alarmTab = byId.get("alarm_house_tab");
if (alarmTab) {
  alarmTab.info =
    "Arma/desarma o alarme Moni Mobile e controla seus retries e avisos, sem acoplamento com a iluminação externa.";
}

const localDateFunction = `const localDate = (value, timeZone) => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(value);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return \`${"${values.year}-${values.month}-${values.day}"}\`;
};`;

const newNodes = [
  {
    id: "ext_sunset_recovery_boot",
    type: "inject",
    z: tabId,
    name: "Verificar pôr do sol perdido no boot",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }],
    repeat: "",
    crontab: "",
    once: true,
    onceDelay: 15,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 210,
    y: 440,
    wires: [["ext_sunset_recovery_sun_check"]],
  },
  {
    id: "ext_sunset_recovery_sun_check",
    type: "api-current-state",
    z: tabId,
    name: "Boot ocorreu depois do pôr do sol?",
    server: haServerId,
    version: 3,
    outputs: 2,
    halt_if: "below_horizon",
    halt_if_type: "str",
    halt_if_compare: "is",
    entity_id: "sun.sun",
    state_type: "str",
    blockInputOverrides: true,
    outputProperties: [
      {
        property: "sun_last_changed",
        propertyType: "msg",
        value: '$entities("sun.sun").last_changed',
        valueType: "jsonata",
      },
    ],
    for: "0",
    forType: "num",
    forUnits: "minutes",
    override_topic: false,
    state_location: "payload",
    override_payload: "msg",
    entity_location: "data",
    override_data: "msg",
    x: 520,
    y: 440,
    wires: [["ext_prepare_recovery_confirmation"], []],
  },
  {
    id: "ext_prepare_recovery_confirmation",
    type: "function",
    z: tabId,
    name: "Preparar confirmação do pôr do sol perdido",
    func: `${localDateFunction}

const STORE = 'persistent';
const PENDING_KEY = 'external_lighting_recovery_pending_v1';
const PROMPTED_DATE_KEY = 'external_lighting_recovery_prompted_date_v1';
const TTL_MS = 12 * 60 * 60 * 1000;
const now = new Date();
const sunsetAt = new Date(msg.sun_last_changed);
const timeZone = env.get('TZ') || 'America/Sao_Paulo';

if (!Number.isFinite(sunsetAt.getTime())) {
    node.status({ fill: 'red', shape: 'ring', text: 'horário do pôr do sol ausente' });
    return null;
}

const today = localDate(now, timeZone);
if (localDate(sunsetAt, timeZone) !== today) {
    node.status({ fill: 'grey', shape: 'ring', text: 'pôr do sol foi em outro dia' });
    return null;
}

const pending = flow.get(PENDING_KEY, STORE);
const promptedDate = flow.get(PROMPTED_DATE_KEY, STORE);
if (promptedDate === today || (pending?.localDate === today && Number(pending.expiresAt) > now.getTime())) {
    node.status({ fill: 'grey', shape: 'ring', text: 'confirmação já enviada hoje' });
    return null;
}

const token = (now.getTime().toString(36) + '_' + Math.random().toString(36).slice(2, 10)).toUpperCase();
const candidate = {
    version: 1,
    localDate: today,
    createdAt: now.getTime(),
    expiresAt: now.getTime() + TTL_MS,
    confirmAction: 'ILUMINACAO_EXTERNA_LIGAR_' + token,
    cancelAction: 'ILUMINACAO_EXTERNA_NAO_LIGAR_' + token
};

msg.external_lighting_recovery_candidate = candidate;
msg.confirm_action = candidate.confirmAction;
msg.cancel_action = candidate.cancelAction;
msg.notification_title = 'Iluminação externa';
msg.notification_message = 'O Node-RED voltou depois do pôr do sol de hoje. Deseja ligar as lâmpadas externas agora?';
msg.notification_tag = 'external_lighting_sunset_recovery';
msg.notify_text = 'O Node-RED voltou depois do pôr do sol. Você ainda quer ligar a iluminação externa? Responda pela notificação que enviei ao celular.';
node.status({ fill: 'yellow', shape: 'dot', text: 'enviando confirmação' });
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 850,
    y: 440,
    wires: [["ext_send_recovery_mobile"]],
  },
  {
    id: "ext_send_recovery_mobile",
    type: "api-call-service",
    z: tabId,
    name: "Perguntar no celular",
    server: haServerId,
    version: 7,
    debugenabled: false,
    action: "public_bindings.call",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: [],
    labelId: [],
    data: '{"role":"mobile_primary","action":"notify_actionable","data":{"title": notification_title, "message": notification_message, "data": {"tag": notification_tag, "actions": [{"action": confirm_action, "title": "Ligar"}, {"action": cancel_action, "title": "Não ligar"}]}}}',
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "all",
    blockInputOverrides: true,
    domain: "public_bindings",
    service: "call",
    x: 1160,
    y: 440,
    wires: [["ext_commit_recovery_confirmation"]],
  },
  {
    id: "ext_commit_recovery_confirmation",
    type: "function",
    z: tabId,
    name: "Registrar confirmação enviada",
    func: `const STORE = 'persistent';
const candidate = msg.external_lighting_recovery_candidate;
if (!candidate?.localDate || !candidate?.confirmAction || !candidate?.cancelAction) {
    node.status({ fill: 'red', shape: 'ring', text: 'confirmação inválida' });
    return null;
}
flow.set('external_lighting_recovery_pending_v1', candidate, STORE);
flow.set('external_lighting_recovery_prompted_date_v1', candidate.localDate, STORE);
node.status({ fill: 'yellow', shape: 'dot', text: 'aguardando resposta no celular' });
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1440,
    y: 440,
    wires: [[alexaNotifyId]],
  },
  {
    id: "ext_recovery_notification_action",
    type: "server-events",
    z: tabId,
    name: "Resposta da confirmação no celular",
    server: haServerId,
    version: 3,
    exposeAsEntityConfig: "",
    eventType: "mobile_app_notification_action",
    eventData: "",
    waitForRunning: true,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: "",
        valueType: "eventData",
      },
    ],
    x: 230,
    y: 520,
    wires: [["ext_validate_recovery_confirmation"]],
  },
  {
    id: "ext_validate_recovery_confirmation",
    type: "function",
    z: tabId,
    name: "Validar confirmação da iluminação",
    func: `${localDateFunction}

const STORE = 'persistent';
const PENDING_KEY = 'external_lighting_recovery_pending_v1';
const pending = flow.get(PENDING_KEY, STORE);
const action = msg.payload?.event?.action ?? msg.payload?.action ?? msg.event?.action ?? null;

if (!pending || typeof action !== 'string') return null;

const now = new Date();
const timeZone = env.get('TZ') || 'America/Sao_Paulo';
if (Number(pending.expiresAt) <= now.getTime() || pending.localDate !== localDate(now, timeZone)) {
    flow.set(PENDING_KEY, null, STORE);
    node.status({ fill: 'grey', shape: 'ring', text: 'confirmação expirada' });
    return null;
}

if (action === pending.cancelAction) {
    flow.set(PENDING_KEY, null, STORE);
    node.status({ fill: 'blue', shape: 'ring', text: 'usuário optou por não ligar' });
    return null;
}

if (action !== pending.confirmAction) return null;

flow.set(PENDING_KEY, null, STORE);
msg.external_lighting_recovery_confirmed = true;
node.status({ fill: 'green', shape: 'dot', text: 'ligação confirmada' });
return msg;`,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 550,
    y: 520,
    wires: [["ext_confirm_recovery_sun_check"]],
  },
  {
    id: "ext_confirm_recovery_sun_check",
    type: "api-current-state",
    z: tabId,
    name: "Ainda está depois do pôr do sol?",
    server: haServerId,
    version: 3,
    outputs: 2,
    halt_if: "below_horizon",
    halt_if_type: "str",
    halt_if_compare: "is",
    entity_id: "sun.sun",
    state_type: "str",
    blockInputOverrides: true,
    outputProperties: [],
    for: "0",
    forType: "num",
    forUnits: "minutes",
    override_topic: false,
    state_location: "payload",
    override_payload: "msg",
    entity_location: "data",
    override_data: "msg",
    x: 860,
    y: 520,
    wires: [[sunsetCommandId], []],
  },
];

const kept = flows.filter(
  (node) => !removedIds.has(node.id) && !managedIds.has(node.id),
);
kept.push(...newNodes);

fs.writeFileSync(flowsPath, `${JSON.stringify(kept, null, 4)}\n`);

if (fs.existsSync(issuesPath)) {
  const issues = JSON.parse(fs.readFileSync(issuesPath, "utf8"));
  const hidden = issues?.issues?.hidden;
  if (Array.isArray(hidden)) {
    issues.issues.hidden = hidden.filter((id) => !removedIds.has(id));
    fs.writeFileSync(issuesPath, `${JSON.stringify(issues, null, 2)}\n`);
  }
}

console.log("External lighting decoupled from Moni Mobile with confirmed sunset recovery.");
