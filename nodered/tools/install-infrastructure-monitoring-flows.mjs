#!/usr/bin/env node

import fs from "node:fs";

const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));

const HA_SERVER = "4126427d5e161a03";
const MQTT_BROKER = "721c47f31046b8bc";
const NOTIFY_SUBFLOW = "infra_notify_all_mobiles";
const INTERNET_TAB = "monitoramento_internet_tab";
const ZIGBEE_TAB = "monitoramento_zigbee_tab";

function body(fn) {
  const source = fn.toString();
  return source.slice(source.indexOf("{") + 1, source.lastIndexOf("}")).trim();
}

function tab(id, label, info) {
  return { id, type: "tab", label, disabled: false, info, env: [] };
}

function group(id, z, name, nodes, x, y, w, h, stroke) {
  return {
    id,
    type: "group",
    z,
    name,
    style: {
      label: true,
      "label-position": "nw",
      stroke,
      "stroke-opacity": "1",
      fill: "none",
      color: "#a4a4a4",
    },
    nodes,
    x,
    y,
    w,
    h,
  };
}

function functionNode({ id, z, g, name, fn, outputs = 1, x, y, wires, initialize = "", finalize = "" }) {
  return {
    id,
    type: "function",
    z,
    ...(g ? { g } : {}),
    name,
    func: body(fn),
    outputs,
    timeout: 0,
    noerr: 0,
    initialize,
    finalize,
    libs: [],
    x,
    y,
    wires,
  };
}

function inject({ id, z, g, name, repeat = "", once = false, onceDelay = 0.1, x, y, wires }) {
  return {
    id,
    type: "inject",
    z,
    ...(g ? { g } : {}),
    name,
    props: [{ p: "payload" }, { p: "topic", vt: "str" }],
    repeat,
    crontab: "",
    once,
    onceDelay,
    topic: "",
    payload: "",
    payloadType: "date",
    x,
    y,
    wires,
  };
}

function mqttIn({ id, z, g, name, topic, x, y, wires }) {
  return {
    id,
    type: "mqtt in",
    z,
    ...(g ? { g } : {}),
    name,
    topic,
    qos: "1",
    datatype: "auto-detect",
    broker: MQTT_BROKER,
    nl: false,
    rap: true,
    rh: 0,
    inputs: 0,
    x,
    y,
    wires,
  };
}

function mqttOut({ id, z, g, name, x, y }) {
  return {
    id,
    type: "mqtt out",
    z,
    ...(g ? { g } : {}),
    name,
    topic: "",
    qos: "1",
    retain: "true",
    respTopic: "",
    contentType: "",
    userProps: "",
    correl: "",
    expiry: "",
    broker: MQTT_BROKER,
    x,
    y,
    wires: [],
  };
}

function notifyInstance(id, z, g, name, x, y) {
  return {
    id,
    type: `subflow:${NOTIFY_SUBFLOW}`,
    z,
    g,
    name,
    env: [],
    x,
    y,
    wires: [],
  };
}

function comment(id, z, g, name, info, x, y) {
  return { id, type: "comment", z, g, name, info, x, y, wires: [] };
}

function notificationRouter() {
  const notification = msg.notification;
  if (!notification || !notification.title || !notification.message || !notification.id) {
    node.warn("Notificação de infraestrutura descartada: título, mensagem ou id ausente.");
    return null;
  }
  const dismiss = notification.dismiss_id ? msg : null;
  return [msg, msg, dismiss];
}

function internetPingCycle() {
  const STORE = "memoryOnly";
  const LOCK = "internet_ping_cycle_running";
  const childProcess = global.get("childProcess");
  const targets = [
    { name: "cloudflare", address: "1.1.1.1" },
    { name: "google", address: "8.8.8.8" },
    { name: "quad9", address: "9.9.9.9" },
  ];

  if (!childProcess || typeof childProcess.execFile !== "function") {
    node.status({ fill: "red", shape: "ring", text: "child_process indisponível" });
    node.error("settings.js não expôs childProcess no contexto global.");
    return null;
  }
  if (flow.get(LOCK, STORE) === true) {
    node.status({ fill: "yellow", shape: "ring", text: "ciclo anterior ainda ativo" });
    return null;
  }

  flow.set(LOCK, true, STORE);
  const startedAt = Date.now();
  node.status({ fill: "blue", shape: "dot", text: "testando 3 destinos" });

  const ping = (target) => new Promise((resolve) => {
    const finish = (error, stdout = "", stderr = "") => resolve({
        ...target,
        ok: !error,
        duration_ms: Date.now() - startedAt,
        error: error ? String(error.code || error.message || stderr || "ping failed") : null,
        output: String(stdout || "").trim().slice(-160),
    });
    try {
      childProcess.execFile(
        "/bin/ping",
        ["-n", "-c", "1", "-W", "2", target.address],
        { timeout: 3000, windowsHide: true },
        finish,
      );
    } catch (error) {
      // Treat a synchronous spawn failure as a failed target. Resolving (not
      // rejecting) keeps Promise.all waiting for every already-started ping,
      // so the no-overlap lock cannot be released while processes remain.
      finish(error);
    }
  });

  Promise.all(targets.map(ping))
    .then((results) => {
      const ok = results.filter((result) => result.ok).length;
      node.status({
        fill: ok >= 2 ? "green" : "red",
        shape: ok >= 2 ? "dot" : "ring",
        text: `${ok}/3 responderam`,
      });
      node.send({
        topic: "infrastructure/internet/ping-cycle",
        payload: {
          checked_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          results,
        },
      });
    })
    .catch((error) => {
      node.error(`Falha inesperada no ciclo de ping: ${error.message}`);
    })
    .finally(() => {
      flow.set(LOCK, false, STORE);
      node.done();
    });
  return undefined;
}

function internetStateMachine() {
  const KEY = "internet_monitor_state_v1";
  const now = Number(msg.monitor_now || Date.now());
  const nowIso = new Date(now).toISOString();
  const results = Array.isArray(msg.payload?.results) ? msg.payload.results : [];
  const targetsTotal = 3;
  const targetsOk = results.filter((result) => result && result.ok === true).length;
  const reachable = targetsOk >= 2;
  let state = flow.get(KEY) || {
    phase: "checking",
    incident_open: false,
    consecutive_failures: 0,
    consecutive_successes: 0,
    failure_started_at: null,
    outage_started_at: null,
    last_outage_at: null,
    last_recovery_at: null,
    last_outage_duration_s: null,
    last_valid_ping: null,
  };
  let downNotification = null;
  let recoveryNotification = null;

  if (reachable) {
    state.last_valid_ping = nowIso;
    state.consecutive_failures = 0;
    state.failure_started_at = null;
    if (state.incident_open) {
      state.consecutive_successes = Number(state.consecutive_successes || 0) + 1;
      state.phase = "recovering";
      if (state.consecutive_successes >= 2) {
        const outageStartMs = Date.parse(state.outage_started_at || state.last_outage_at || nowIso);
        const durationSeconds = Number.isFinite(outageStartMs)
          ? Math.max(0, Math.round((now - outageStartMs) / 1000))
          : null;
        state.phase = "online";
        state.incident_open = false;
        state.consecutive_successes = 0;
        state.last_recovery_at = nowIso;
        state.last_outage_duration_s = durationSeconds;
        const durationText = durationSeconds === null
          ? ""
          : ` após ${Math.max(1, Math.round(durationSeconds / 60))} minuto(s) de indisponibilidade`;
        recoveryNotification = {
          notification: {
            id: "internet_connection_recovered",
            dismiss_id: "internet_connection_failure",
            title: "Internet restabelecida",
            message: `A conexão com a internet voltou às ${new Date(now).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}${durationText}.`,
          },
        };
      }
    } else {
      // Establishing a healthy baseline is not a recovery event.
      state.phase = "online";
      state.consecutive_successes = 1;
    }
  } else {
    state.consecutive_successes = 0;
    state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
    if (!state.failure_started_at) state.failure_started_at = nowIso;
    if (state.incident_open) {
      state.phase = "offline";
    } else if (state.consecutive_failures >= 3) {
      state.phase = "offline";
      state.incident_open = true;
      state.outage_started_at = state.failure_started_at;
      state.last_outage_at = state.failure_started_at;
      downNotification = {
        notification: {
          id: "internet_connection_failure",
          title: "Internet indisponível",
          message: `A conexão com a internet foi perdida às ${new Date(state.failure_started_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. Menos de 2 dos 3 destinos externos responderam em 3 ciclos consecutivos.`,
        },
      };
    } else {
      state.phase = "checking";
    }
  }

  state.last_checked_at = msg.payload?.checked_at || nowIso;
  state.targets_ok = targetsOk;
  state.targets_total = targetsTotal;
  state.required_responses = 2;
  flow.set(KEY, state);

  const attributes = {
    state: state.phase,
    checked_at: state.last_checked_at,
    targets_ok: targetsOk,
    targets_total: targetsTotal,
    required_responses: 2,
    consecutive_failures: state.consecutive_failures,
    consecutive_successes: state.consecutive_successes,
    last_valid_ping: state.last_valid_ping,
    last_outage: state.last_outage_at,
    last_recovery: state.last_recovery_at,
    last_outage_duration_s: state.last_outage_duration_s,
    targets: results.map((result) => ({ name: result.name, address: result.address, ok: result.ok })),
  };
  const publications = [
    { topic: "nodered/infrastructure/internet/connection", payload: state.phase === "online" ? "ON" : "OFF" },
    { topic: "nodered/infrastructure/internet/attributes", payload: JSON.stringify(attributes) },
    { topic: "nodered/infrastructure/internet/state", payload: state.phase },
  ];
  node.status({
    fill: state.phase === "online" ? "green" : state.phase === "offline" ? "red" : "yellow",
    shape: state.phase === "online" ? "dot" : "ring",
    text: `${state.phase}: ${targetsOk}/3`,
  });
  return [downNotification, recoveryNotification, publications];
}

function internetDiscovery() {
  const device = {
    identifiers: ["node_red_infrastructure_monitoring"],
    name: "Monitoramento de infraestrutura",
    manufacturer: "Node-RED",
    model: "Flows de disponibilidade",
  };
  const availability = {
    availability_topic: "nodered/status",
    payload_available: "online",
    payload_not_available: "offline",
  };
  return [[
    {
      topic: "homeassistant/binary_sensor/internet_connection/config",
      payload: JSON.stringify({
        name: "Conexão com a internet",
        object_id: "internet_connection",
        default_entity_id: "binary_sensor.internet_connection",
        unique_id: "node_red_internet_connection",
        device_class: "connectivity",
        state_topic: "nodered/infrastructure/internet/connection",
        json_attributes_topic: "nodered/infrastructure/internet/attributes",
        payload_on: "ON",
        payload_off: "OFF",
        ...availability,
        device,
      }),
    },
    {
      topic: "homeassistant/sensor/internet_connection_state/config",
      payload: JSON.stringify({
        name: "Estado da conexão com a internet",
        object_id: "internet_connection_state",
        default_entity_id: "sensor.internet_connection_state",
        unique_id: "node_red_internet_connection_state",
        icon: "mdi:wan",
        entity_category: "diagnostic",
        state_topic: "nodered/infrastructure/internet/state",
        json_attributes_topic: "nodered/infrastructure/internet/attributes",
        ...availability,
        device,
      }),
    },
  ]];
}

function zigbeeObservation() {
  const KEY = "zigbee_bridge_observation";
  const STORE = "memoryOnly";
  const now = Number(msg.monitor_now || Date.now());
  let observed;

  if (msg.status) {
    const text = String(msg.status.text || "").toLowerCase();
    if (msg.status.fill === "red" || /disconnected|offline|error/.test(text)) observed = "offline";
    else return null;
  } else {
    let value = msg.payload;
    if (Buffer.isBuffer(value)) value = value.toString("utf8");
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        value = parsed?.state ?? parsed;
      } catch {
        // Zigbee2MQTT also publishes plain online/offline strings.
      }
    }
    if (value && typeof value === "object") value = value.state;
    observed = String(value || "").toLowerCase();
  }
  if (!new Set(["online", "offline"]).has(observed)) return null;

  const previous = flow.get(KEY, STORE);
  flow.set(KEY, {
    state: observed,
    changed_at: previous?.state === observed ? previous.changed_at : now,
  }, STORE);
  msg.monitor_now = now;
  return msg;
}

function zigbeeStateMachine() {
  const KEY = "zigbee_network_monitor_state_v1";
  const OBSERVATION_KEY = "zigbee_bridge_observation";
  const now = Number(msg.monitor_now || Date.now());
  const nowIso = new Date(now).toISOString();
  const observation = flow.get(OBSERVATION_KEY, "memoryOnly") || { state: "unknown", changed_at: now };
  const rawState = observation.state;
  const stableForMs = Math.max(0, now - Number(observation.changed_at || now));
  let state = flow.get(KEY) || {
    phase: "checking",
    incident_open: false,
    outage_started_at: null,
    last_outage_at: null,
    last_recovery_at: null,
    last_outage_duration_s: null,
  };
  let downNotification = null;
  let recoveryNotification = null;

  if (rawState === "online") {
    if (state.incident_open) {
      state.phase = "recovering";
      if (stableForMs >= 60_000) {
        const outageStartMs = Date.parse(state.outage_started_at || state.last_outage_at || nowIso);
        state.last_outage_duration_s = Number.isFinite(outageStartMs)
          ? Math.max(0, Math.round((now - outageStartMs) / 1000))
          : null;
        state.phase = "online";
        state.incident_open = false;
        state.last_recovery_at = nowIso;
        recoveryNotification = {
          notification: {
            id: "zigbee_network_recovered",
            dismiss_id: "zigbee_network_failure",
            title: "Rede Zigbee recuperada",
            message: `A rede Zigbee voltou a funcionar e permaneceu conectada por 1 minuto. Recuperada em ${new Date(now).toLocaleString("pt-BR")}.`,
          },
        };
      }
    } else {
      // Retained online at startup establishes baseline without false recovery.
      state.phase = "online";
    }
  } else if (state.incident_open) {
    state.phase = "offline";
  } else if (stableForMs >= 30_000) {
    state.phase = "offline";
    state.incident_open = true;
    state.outage_started_at = new Date(Number(observation.changed_at || now)).toISOString();
    state.last_outage_at = state.outage_started_at;
    downNotification = {
      notification: {
        id: "zigbee_network_failure",
        title: "Falha na rede Zigbee",
        message: `A rede Zigbee está indisponível. O Zigbee2MQTT perdeu a conexão com a antena/coordenador ou parou de funcionar. Detectado em ${new Date(now).toLocaleString("pt-BR")}.`,
      },
    };
  } else {
    state.phase = "checking";
  }

  state.raw_state = rawState;
  state.last_checked_at = nowIso;
  state.stable_for_s = Math.floor(stableForMs / 1000);
  flow.set(KEY, state);
  const attributes = {
    state: state.phase,
    raw_state: rawState,
    stable_for_s: state.stable_for_s,
    checked_at: nowIso,
    last_outage: state.last_outage_at,
    last_recovery: state.last_recovery_at,
    last_outage_duration_s: state.last_outage_duration_s,
    failure_confirmation_s: 30,
    recovery_confirmation_s: 60,
  };
  const publications = [
    { topic: "nodered/infrastructure/zigbee/connection", payload: state.phase === "online" ? "ON" : "OFF" },
    { topic: "nodered/infrastructure/zigbee/attributes", payload: JSON.stringify(attributes) },
    { topic: "nodered/infrastructure/zigbee/state", payload: state.phase },
  ];
  node.status({
    fill: state.phase === "online" ? "green" : state.phase === "offline" ? "red" : "yellow",
    shape: state.phase === "online" ? "dot" : "ring",
    text: `${state.phase}: ${rawState}`,
  });
  return [downNotification, recoveryNotification, publications];
}

function zigbeeComponentState() {
  const KEY = "zigbee_component_incidents_v1";
  if (!String(msg.topic || "").endsWith("/availability")) return null;
  let value = msg.payload;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      value = parsed?.state ?? parsed;
    } catch {
      // Plain online/offline is valid.
    }
  }
  if (value && typeof value === "object") value = value.state;
  const availability = String(value || "").toLowerCase();
  if (!new Set(["online", "offline"]).has(availability)) return null;

  const component = String(msg.topic).slice("zigbee2mqtt/".length, -"/availability".length);
  if (!component) return null;
  const slug = component.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  // Separator/accent normalization is not injective. Keep the readable slug,
  // but append a stable hash of the exact friendly name so distinct MQTT
  // topics cannot overwrite or dismiss each other's persistent notification.
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(component, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const notificationKey = `${slug || "component"}_${hash.toString(16).padStart(8, "0")}`;
  const incidents = flow.get(KEY) || {};
  const current = incidents[component] || { offline: false };
  const now = Number(msg.monitor_now || Date.now());
  const nowIso = new Date(now).toISOString();

  if (availability === "offline") {
    if (current.offline) return null;
    incidents[component] = { offline: true, outage_started_at: nowIso, last_seen_at: nowIso };
    flow.set(KEY, incidents);
    return [{
      notification: {
        id: `zigbee_component_${notificationKey}`,
        title: "Componente Zigbee indisponível",
        message: `O componente Zigbee “${component}” ficou indisponível em ${new Date(now).toLocaleString("pt-BR")}. Verifique alimentação, alcance, bateria e a malha Zigbee.`,
      },
    }, null];
  }

  incidents[component] = { ...current, offline: false, recovered_at: nowIso, last_seen_at: nowIso };
  flow.set(KEY, incidents);
  if (!current.offline) return null;
  return [null, {
    notification: {
      id: `zigbee_component_recovered_${notificationKey}`,
      dismiss_id: `zigbee_component_${notificationKey}`,
      title: "Componente Zigbee recuperado",
      message: `O componente Zigbee “${component}” voltou a ficar disponível em ${new Date(now).toLocaleString("pt-BR")}.`,
    },
  }];
}

function zigbeeDiscovery() {
  const device = {
    identifiers: ["node_red_infrastructure_monitoring"],
    name: "Monitoramento de infraestrutura",
    manufacturer: "Node-RED",
    model: "Flows de disponibilidade",
  };
  const availability = {
    availability_topic: "nodered/status",
    payload_available: "online",
    payload_not_available: "offline",
  };
  return [[
    {
      topic: "homeassistant/binary_sensor/zigbee_network/config",
      payload: JSON.stringify({
        name: "Rede Zigbee",
        object_id: "zigbee_network",
        default_entity_id: "binary_sensor.zigbee_network",
        unique_id: "node_red_zigbee_network",
        device_class: "connectivity",
        state_topic: "nodered/infrastructure/zigbee/connection",
        json_attributes_topic: "nodered/infrastructure/zigbee/attributes",
        payload_on: "ON",
        payload_off: "OFF",
        ...availability,
        device,
      }),
    },
    {
      topic: "homeassistant/sensor/zigbee_network_state/config",
      payload: JSON.stringify({
        name: "Estado da rede Zigbee",
        object_id: "zigbee_network_state",
        default_entity_id: "sensor.zigbee_network_state",
        unique_id: "node_red_zigbee_network_state",
        icon: "mdi:zigbee",
        entity_category: "diagnostic",
        state_topic: "nodered/infrastructure/zigbee/state",
        json_attributes_topic: "nodered/infrastructure/zigbee/attributes",
        ...availability,
        device,
      }),
    },
  ]];
}

const oldIds = new Set([
  NOTIFY_SUBFLOW,
  INTERNET_TAB,
  ZIGBEE_TAB,
  ...flows.filter((node) => node.z === NOTIFY_SUBFLOW || node.z === INTERNET_TAB || node.z === ZIGBEE_TAB).map((node) => node.id),
]);
const next = flows.filter((node) => !oldIds.has(node.id) && node.z !== NOTIFY_SUBFLOW && node.z !== INTERNET_TAB && node.z !== ZIGBEE_TAB);

const broker = next.find((node) => node.id === MQTT_BROKER);
if (!broker) throw new Error("Configuração MQTT esperada não foi encontrada.");
Object.assign(broker, {
  birthTopic: "nodered/status",
  birthQos: "1",
  birthRetain: "true",
  birthPayload: "online",
  closeTopic: "nodered/status",
  closeQos: "1",
  closeRetain: "true",
  closePayload: "offline",
  willTopic: "nodered/status",
  willQos: "1",
  willRetain: "true",
  willPayload: "offline",
});

next.push(
  {
    id: NOTIFY_SUBFLOW,
    type: "subflow",
    name: "Notificar todos os dispositivos móveis",
    info: "Contrato de entrada:\n\nmsg.notification = {\n  id: string obrigatório,\n  title: string obrigatório,\n  message: string obrigatório,\n  dismiss_id?: string\n}\n\nCria/atualiza uma notificação persistente e envia um push aos iPhones de Gabriel e Valéria. Em recuperação, dismiss_id remove o alerta persistente da falha anterior. O subflow não decide estado, retry ou deduplicação; essas responsabilidades pertencem ao monitor chamador.",
    category: "infraestrutura",
    in: [{ x: 60, y: 80, wires: [{ id: "infra_notify_route" }] }],
    out: [],
    env: [],
    meta: {},
    color: "#DDAA99",
  },
  functionNode({
    id: "infra_notify_route", z: NOTIFY_SUBFLOW, name: "Validar e distribuir", fn: notificationRouter,
    outputs: 3, x: 220, y: 80,
    wires: [["infra_notify_persistent"], ["infra_notify_mobile"], ["infra_notify_dismiss"]],
  }),
  {
    id: "infra_notify_persistent", type: "api-call-service", z: NOTIFY_SUBFLOW,
    name: "Criar/atualizar alerta persistente", server: HA_SERVER, version: 7, debugenabled: false,
    action: "persistent_notification.create", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
    data: "{\"title\": notification.title, \"message\": notification.message, \"notification_id\": notification.id}",
    dataType: "jsonata", mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all",
    blockInputOverrides: true, domain: "persistent_notification", service: "create", x: 520, y: 40, wires: [[]],
  },
  {
    id: "infra_notify_mobile", type: "api-call-service", z: NOTIFY_SUBFLOW,
    name: "Push Gabriel + Valéria", server: HA_SERVER, version: 7, debugenabled: false,
    action: "notify.send_message", floorId: [], areaId: [], deviceId: [],
    entityId: ["notify.iphone_de_gabriel_furlan", "notify.iphone_de_valeria"], labelId: [],
    data: "{\"title\": notification.title, \"message\": notification.message}", dataType: "jsonata",
    mergeContext: "", mustacheAltTags: false, outputProperties: [], queue: "all",
    blockInputOverrides: true, domain: "notify", service: "send_message", x: 500, y: 80, wires: [[]],
  },
  {
    id: "infra_notify_dismiss", type: "api-call-service", z: NOTIFY_SUBFLOW,
    name: "Remover alerta anterior", server: HA_SERVER, version: 7, debugenabled: false,
    action: "persistent_notification.dismiss", floorId: [], areaId: [], deviceId: [], entityId: [], labelId: [],
    data: "{\"notification_id\": notification.dismiss_id}", dataType: "jsonata", mergeContext: "",
    mustacheAltTags: false, outputProperties: [], queue: "all", blockInputOverrides: true,
    domain: "persistent_notification", service: "dismiss", x: 500, y: 120, wires: [[]],
  },
);

const internetGroups = {
  triggers: ["internet_cycle", "internet_discovery_tick"],
  ping: ["internet_ping"],
  state: ["internet_evaluate"],
  notify: ["internet_notify_down", "internet_notify_recovery"],
  publish: ["internet_discovery", "internet_mqtt_publish"],
  tests: ["internet_test_note"],
};
next.push(
  tab(INTERNET_TAB, "monitoramento_internet", "Monitora conectividade externa por ping a três IPs independentes, confirma queda/recuperação e publica estado no Home Assistant via MQTT discovery."),
  group("grp_internet_triggers", INTERNET_TAB, "1. Gatilhos", internetGroups.triggers, 44, 79, 252, 302, "#3f7cb5"),
  group("grp_internet_ping", INTERNET_TAB, "2. Testar conectividade", internetGroups.ping, 324, 79, 252, 162, "#7d6ba8"),
  group("grp_internet_state", INTERNET_TAB, "3. Confirmação e estado", internetGroups.state, 604, 79, 282, 162, "#4d9a6a"),
  group("grp_internet_notify", INTERNET_TAB, "4. Queda / retorno / notify", internetGroups.notify, 914, 59, 342, 222, "#b5563f"),
  group("grp_internet_publish", INTERNET_TAB, "5. Entidades do Home Assistant", internetGroups.publish, 604, 319, 652, 162, "#c98a2b"),
  group("grp_internet_tests", INTERNET_TAB, "6. Testes", internetGroups.tests, 44, 519, 1212, 102, "#8a8a8a"),
  inject({ id: "internet_cycle", z: INTERNET_TAB, g: "grp_internet_triggers", name: "A cada 30 s + startup", repeat: "30", once: true, onceDelay: 5, x: 170, y: 160, wires: [["internet_ping"]] }),
  inject({ id: "internet_discovery_tick", z: INTERNET_TAB, g: "grp_internet_triggers", name: "Publicar discovery no startup", once: true, onceDelay: 2, x: 170, y: 320, wires: [["internet_discovery"]] }),
  functionNode({
    id: "internet_ping", z: INTERNET_TAB, g: "grp_internet_ping", name: "Ping 1.1.1.1 + 8.8.8.8 + 9.9.9.9",
    fn: internetPingCycle, x: 450, y: 160, wires: [["internet_evaluate"]],
    finalize: "flow.set('internet_ping_cycle_running', false, 'memoryOnly');",
  }),
  functionNode({
    id: "internet_evaluate", z: INTERNET_TAB, g: "grp_internet_state", name: "Máquina de estados (3 falhas / 2 sucessos)",
    fn: internetStateMachine, outputs: 3, x: 745, y: 160,
    wires: [["internet_notify_down"], ["internet_notify_recovery"], ["internet_mqtt_publish"]],
  }),
  notifyInstance("internet_notify_down", INTERNET_TAB, "grp_internet_notify", "Notificar queda (uma vez)", 1085, 140),
  notifyInstance("internet_notify_recovery", INTERNET_TAB, "grp_internet_notify", "Notificar retorno confirmado", 1085, 220),
  functionNode({ id: "internet_discovery", z: INTERNET_TAB, g: "grp_internet_publish", name: "Discovery: internet", fn: internetDiscovery, x: 760, y: 400, wires: [["internet_mqtt_publish"]] }),
  mqttOut({ id: "internet_mqtt_publish", z: INTERNET_TAB, g: "grp_internet_publish", name: "Publicar estado retained", x: 1080, y: 400 }),
  comment(
    "internet_test_note", INTERNET_TAB, "grp_internet_tests", "Testes automatizados fora do caminho de produção",
    "Execute `npm run flows:test-infrastructure`. O teste cobre 1 host falhando, DNS irrelevante (IPs), 3 falhas, dedupe, oscilação, 2 sucessos, duração, segunda queda e restart. O ciclo real nunca aceita mensagens de teste e mantém no máximo três processos ping simultâneos.",
    420, 570,
  ),
);

const zigbeeGroups = {
  triggers: ["zigbee_bridge_state", "zigbee_broker_status", "zigbee_tick", "zigbee_component_availability", "zigbee_discovery_tick"],
  detect: ["zigbee_store_observation", "zigbee_component_evaluate"],
  state: ["zigbee_network_evaluate"],
  notify: ["zigbee_network_notify_down", "zigbee_network_notify_recovery", "zigbee_component_notify_down", "zigbee_component_notify_recovery"],
  publish: ["zigbee_discovery", "zigbee_mqtt_publish"],
  tests: ["zigbee_test_note"],
};
next.push(
  tab(ZIGBEE_TAB, "monitoramento_zigbee", "Centraliza falha/recuperação da ponte Zigbee2MQTT e dos componentes, com estado persistente, dedupe e notificações compartilhadas."),
  group("grp_zigbee_triggers", ZIGBEE_TAB, "1. Estado / heartbeat Zigbee", zigbeeGroups.triggers, 44, 79, 292, 482, "#3f7cb5"),
  group("grp_zigbee_detect", ZIGBEE_TAB, "2. Avaliar saúde", zigbeeGroups.detect, 364, 79, 272, 482, "#7d6ba8"),
  group("grp_zigbee_state", ZIGBEE_TAB, "3. Confirmar falha / recuperação", zigbeeGroups.state, 664, 79, 292, 202, "#4d9a6a"),
  group("grp_zigbee_notify", ZIGBEE_TAB, "4. Notificação", zigbeeGroups.notify, 984, 59, 352, 502, "#b5563f"),
  group("grp_zigbee_publish", ZIGBEE_TAB, "5. Entidades do Home Assistant", zigbeeGroups.publish, 664, 359, 292, 202, "#c98a2b"),
  group("grp_zigbee_tests", ZIGBEE_TAB, "6. Testes", zigbeeGroups.tests, 44, 599, 1292, 102, "#8a8a8a"),
  mqttIn({ id: "zigbee_bridge_state", z: ZIGBEE_TAB, g: "grp_zigbee_triggers", name: "zigbee2mqtt/bridge/state", topic: "zigbee2mqtt/bridge/state", x: 190, y: 140, wires: [["zigbee_store_observation"]] }),
  {
    id: "zigbee_broker_status", type: "status", z: ZIGBEE_TAB, g: "grp_zigbee_triggers",
    name: "Conexão MQTT", scope: ["zigbee_bridge_state"], x: 180, y: 200, wires: [["zigbee_store_observation"]],
  },
  inject({ id: "zigbee_tick", z: ZIGBEE_TAB, g: "grp_zigbee_triggers", name: "Avaliar a cada 10 s", repeat: "10", once: true, onceDelay: 5, x: 180, y: 260, wires: [["zigbee_network_evaluate"]] }),
  mqttIn({ id: "zigbee_component_availability", z: ZIGBEE_TAB, g: "grp_zigbee_triggers", name: "zigbee2mqtt/.../availability", topic: "zigbee2mqtt/#", x: 190, y: 400, wires: [["zigbee_component_evaluate"]] }),
  inject({ id: "zigbee_discovery_tick", z: ZIGBEE_TAB, g: "grp_zigbee_triggers", name: "Publicar discovery no startup", once: true, onceDelay: 2, x: 190, y: 500, wires: [["zigbee_discovery"]] }),
  functionNode({
    id: "zigbee_store_observation", z: ZIGBEE_TAB, g: "grp_zigbee_detect", name: "Normalizar e guardar observação",
    fn: zigbeeObservation, x: 500, y: 170, wires: [["zigbee_network_evaluate"]],
    initialize: "flow.set('zigbee_bridge_observation', { state: 'unknown', changed_at: Date.now() }, 'memoryOnly');",
  }),
  functionNode({
    id: "zigbee_component_evaluate", z: ZIGBEE_TAB, g: "grp_zigbee_detect", name: "Dedupe por componente",
    fn: zigbeeComponentState, outputs: 2, x: 500, y: 400,
    wires: [["zigbee_component_notify_down"], ["zigbee_component_notify_recovery"]],
  }),
  functionNode({
    id: "zigbee_network_evaluate", z: ZIGBEE_TAB, g: "grp_zigbee_state", name: "30 s queda / 60 s retorno",
    fn: zigbeeStateMachine, outputs: 3, x: 810, y: 170,
    wires: [["zigbee_network_notify_down"], ["zigbee_network_notify_recovery"], ["zigbee_mqtt_publish"]],
  }),
  notifyInstance("zigbee_network_notify_down", ZIGBEE_TAB, "grp_zigbee_notify", "Notificar queda da rede", 1160, 140),
  notifyInstance("zigbee_network_notify_recovery", ZIGBEE_TAB, "grp_zigbee_notify", "Notificar retorno da rede", 1160, 220),
  notifyInstance("zigbee_component_notify_down", ZIGBEE_TAB, "grp_zigbee_notify", "Notificar componente offline", 1160, 400),
  notifyInstance("zigbee_component_notify_recovery", ZIGBEE_TAB, "grp_zigbee_notify", "Notificar componente online", 1160, 480),
  functionNode({ id: "zigbee_discovery", z: ZIGBEE_TAB, g: "grp_zigbee_publish", name: "Discovery: Zigbee", fn: zigbeeDiscovery, x: 790, y: 440, wires: [["zigbee_mqtt_publish"]] }),
  mqttOut({ id: "zigbee_mqtt_publish", z: ZIGBEE_TAB, g: "grp_zigbee_publish", name: "Publicar estado retained", x: 810, y: 500 }),
  comment(
    "zigbee_test_note", ZIGBEE_TAB, "grp_zigbee_tests", "Testes automatizados fora do caminho de produção",
    "Execute `npm run flows:test-infrastructure`. O teste cobre startup, falha momentânea, 30 s offline, dedupe, 60 s de recuperação, restart persistente, componente offline/online e nova queda. Teste MQTT ponta a ponta deve usar um componente fictício retained, conforme a documentação.",
    450, 650,
  ),
);

fs.writeFileSync(flowUrl, `${JSON.stringify(next, null, 4)}\n`);
console.log("Flows de monitoramento de infraestrutura instalados.");
