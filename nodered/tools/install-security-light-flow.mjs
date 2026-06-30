import fs from "node:fs";

const flowsUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowsUrl, "utf8"));

const TAB_ID = "2fd40fd570e6f37a";
const SERVER_ID = "4126427d5e161a03";
const HOME_LAT = -20.310367851039004;
const HOME_LON = -40.317321761139894;

const nodeIds = new Set([
  "sec_comment_arrival_light",
  "sec_arrival_state_changed",
  "sec_gabriel_location_changed",
  "sec_valeria_location_changed",
  "sec_creta_location_changed",
  "sec_sun_changed",
  "sec_creta_lock_context_changed",
  "sec_engine_off_changed",
  "sec_creta_locked_changed",
  "sec_refresh_comment",
  "sec_refresh_every_10min",
  "sec_refresh_creta_entities",
  "sec_request_gabriel_location",
  "sec_request_valeria_location",
  "sec_arrival_decision",
  "sec_reflector_turn_on",
  "sec_auto_off_delay",
  "sec_auto_off_event",
  "sec_reflector_turn_off",
]);

function entitiesJsonata(event, source) {
  return `(
  {
    "event": "${event}",
    "source": "${source}",
    "sun": $entities("sun.sun"),
    "gabriel": $entities("device_tracker.iphone_de_gabriel_furlan"),
    "valeria": $entities("device_tracker.iphone_de_valeria"),
    "creta": $entities("device_tracker.creta_location"),
    "creta_engine": $entities("binary_sensor.creta_engine"),
    "creta_lock": $entities("lock.creta_door_lock")
  }
)`;
}

function turnOffJsonata(reason) {
  return `(
  {
    "event": "turn_off",
    "reason": "${reason}",
    "sun": $entities("sun.sun"),
    "creta": $entities("device_tracker.creta_location"),
    "creta_engine": $entities("binary_sensor.creta_engine"),
    "creta_lock": $entities("lock.creta_door_lock")
  }
)`;
}

function stateChangedNode({
  id,
  name,
  entity,
  payload,
  x,
  y,
  ifState = "",
  holdFor = "0",
  holdForUnits = "minutes",
}) {
  return {
    id,
    type: "server-state-changed",
    z: TAB_ID,
    name,
    server: SERVER_ID,
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: {
      entity: [entity],
      substring: [],
      regex: [],
    },
    outputInitially: false,
    stateType: "str",
    ifState,
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: holdFor,
    forType: "num",
    forUnits: holdForUnits,
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: payload,
        valueType: "jsonata",
      },
    ],
    x,
    y,
    wires: [["sec_arrival_decision"]],
  };
}

const decisionFunction = `const HOME_LAT = ${HOME_LAT};
const HOME_LON = ${HOME_LON};
const event = msg.payload?.event;

const ACTIVE_KEY = "refletor_portao_carros_active_by_arrival";
const ARMED_KEY = "refletor_portao_carros_arrival_armed_entities";
const ARM_DISTANCE_M = 100;
const ARRIVAL_DISTANCE_M = 50;

function distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function position(entity) {
    const attrs = entity?.attributes ?? {};
    const lat = Number(attrs.latitude);
    const lon = Number(attrs.longitude);
    const gpsAccuracy = Number(attrs.gps_accuracy);
    const valid = Number.isFinite(lat) && Number.isFinite(lon);

    return {
        entity_id: entity?.entity_id,
        state: entity?.state,
        latitude: valid ? lat : null,
        longitude: valid ? lon : null,
        gps_accuracy: Number.isFinite(gpsAccuracy) ? gpsAccuracy : null,
        distance_m: valid ? Math.round(distanceMeters(HOME_LAT, HOME_LON, lat, lon)) : null,
    };
}

function isAway(item) {
    return item.state === "not_home" || (item.distance_m !== null && item.distance_m > ARM_DISTANCE_M);
}

function isHome(item) {
    return item.state === "home" || (item.distance_m !== null && item.distance_m <= ARRIVAL_DISTANCE_M);
}

function updateAwayArming(armed, people) {
    for (const [name, item] of Object.entries(people)) {
        if (isAway(item)) {
            armed[name] = true;
        }
    }
}

function clearCurrentHomeArming(armed, people) {
    for (const [name, item] of Object.entries(people)) {
        if (isHome(item)) {
            armed[name] = false;
        }
    }
}

const gabriel = position(msg.payload?.gabriel);
const valeria = position(msg.payload?.valeria);
const creta = position(msg.payload?.creta);
const trackedPeople = { gabriel, valeria };
const sunBelow = msg.payload?.sun?.state === "below_horizon";
const engineOn = msg.payload?.creta_engine?.state === "on";
const lockState = msg.payload?.creta_lock?.state;
const armedEntities = flow.get(ARMED_KEY) ?? {};
const active = flow.get(ACTIVE_KEY) === true;

msg.payload = {
    event,
    source: msg.payload?.source,
    reason: msg.payload?.reason,
    sun_below_horizon: sunBelow,
    gabriel,
    valeria,
    creta,
    creta_home: isHome(creta),
    creta_engine_on: engineOn,
    creta_lock: lockState,
    arriving: [],
};

if (event === "turn_off") {
    if (!msg.payload.creta_home) {
        msg.payload.ignored = true;
        msg.payload.reason = \`\${msg.payload.reason}_ignored_creta_not_home\`;
        return [null, null];
    }

    if (active) {
        flow.set(ACTIVE_KEY, false);
        flow.set(ARMED_KEY, {});
        return [null, msg];
    }
    return [null, null];
}

if (event === "context_update") {
    updateAwayArming(armedEntities, trackedPeople);
    clearCurrentHomeArming(armedEntities, trackedPeople);
    flow.set(ARMED_KEY, armedEntities);
    return [null, null];
}

if (event !== "location_update") {
    return [null, null];
}

updateAwayArming(armedEntities, trackedPeople);

const source = msg.payload.source;
const sourcePosition = trackedPeople[source];
if (sourcePosition && isHome(sourcePosition)) {
    if (armedEntities[source]) {
        msg.payload.arriving.push(source);
    }
    armedEntities[source] = false;
}

flow.set(ARMED_KEY, armedEntities);

msg.payload.should_turn_on =
    !active &&
    sunBelow &&
    engineOn &&
    msg.payload.arriving.length > 0;

if (msg.payload.should_turn_on) {
    flow.set(ACTIVE_KEY, true);
    msg.payload.reason = "arriving_after_dark";
    return [msg, null];
}

return [null, null];`;

const newNodes = [
  {
    id: "sec_comment_arrival_light",
    type: "comment",
    z: TAB_ID,
    name: "Liga refletor_portao_carros somente quando a chegada acontece no escuro",
    info: "Localizacao de Gabriel e Valeria aciona a luz quando alguem armado volta para ate 50 m de casa durante a noite e com o motor do Creta ligado. O por do sol, a localizacao e a trava do Creta apenas atualizam contexto; eles nao reaproveitam chegada antiga nem ligam a luz sozinhos. Gabriel e Valeria armam ao ficar a mais de 100 m de casa. Creta desligou/travou so desliga o refletor se o Creta estiver em casa.",
    x: 590,
    y: 60,
    wires: [],
  },
  stateChangedNode({
    id: "sec_gabriel_location_changed",
    name: "Localizacao Gabriel",
    entity: "device_tracker.iphone_de_gabriel_furlan",
    payload: entitiesJsonata("location_update", "gabriel"),
    x: 180,
    y: 120,
  }),
  stateChangedNode({
    id: "sec_valeria_location_changed",
    name: "Localizacao Valeria",
    entity: "device_tracker.iphone_de_valeria",
    payload: entitiesJsonata("location_update", "valeria"),
    x: 180,
    y: 180,
  }),
  stateChangedNode({
    id: "sec_creta_location_changed",
    name: "Localizacao Creta",
    entity: "device_tracker.creta_location",
    payload: entitiesJsonata("location_update", "creta"),
    x: 180,
    y: 240,
  }),
  stateChangedNode({
    id: "sec_sun_changed",
    name: "Por do sol / amanhecer",
    entity: "sun.sun",
    payload: entitiesJsonata("context_update", "sun"),
    x: 190,
    y: 320,
  }),
  stateChangedNode({
    id: "sec_creta_lock_context_changed",
    name: "Trava porta Creta atualizou",
    entity: "lock.creta_door_lock",
    payload: entitiesJsonata("context_update", "creta_lock"),
    x: 210,
    y: 380,
  }),
  stateChangedNode({
    id: "sec_engine_off_changed",
    name: "Creta desligou (se em casa)",
    entity: "binary_sensor.creta_engine",
    payload: turnOffJsonata("creta_engine_off"),
    x: 210,
    y: 460,
    ifState: "off",
    holdFor: "5",
    holdForUnits: "seconds",
  }),
  stateChangedNode({
    id: "sec_creta_locked_changed",
    name: "Creta travou (se em casa)",
    entity: "lock.creta_door_lock",
    payload: turnOffJsonata("creta_locked"),
    x: 210,
    y: 520,
    ifState: "locked",
    holdFor: "5",
    holdForUnits: "seconds",
  }),
  {
    id: "sec_refresh_comment",
    type: "comment",
    z: TAB_ID,
    name: "Atualiza localizacoes e estado do Creta a cada 10 min",
    info: "Forca update_entity nas entidades Kia/Hyundai e envia request_location_update para os iPhones pelo app do Home Assistant. O iOS e a API Kia ainda podem atrasar ou ignorar uma requisicao, mas o fluxo deixa de depender apenas de atualizacoes espontaneas.",
    x: 560,
    y: 620,
    wires: [],
  },
  {
    id: "sec_refresh_every_10min",
    type: "inject",
    z: TAB_ID,
    name: "A cada 10 min",
    props: [
      {
        p: "payload",
      },
      {
        p: "topic",
        vt: "str",
      },
    ],
    repeat: "600",
    crontab: "",
    once: true,
    onceDelay: "30",
    topic: "refresh_security_entities",
    payload: "",
    payloadType: "date",
    x: 170,
    y: 680,
    wires: [["sec_refresh_creta_entities", "sec_request_gabriel_location", "sec_request_valeria_location"]],
  },
  {
    id: "sec_refresh_creta_entities",
    type: "api-call-service",
    z: TAB_ID,
    name: "Atualizar Creta",
    server: SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "homeassistant.update_entity",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: [
      "device_tracker.creta_location",
      "binary_sensor.creta_engine",
      "lock.creta_door_lock",
    ],
    labelId: [],
    data: "",
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "homeassistant",
    service: "update_entity",
    x: 430,
    y: 640,
    wires: [[]],
  },
  {
    id: "sec_request_gabriel_location",
    type: "api-call-service",
    z: TAB_ID,
    name: "Atualizar iPhone Gabriel",
    server: SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "notify.send_message",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: ["notify.iphone_de_gabriel_furlan"],
    labelId: [],
    data: "{\"message\":\"request_location_update\"}",
    dataType: "json",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "notify",
    service: "send_message",
    x: 460,
    y: 700,
    wires: [[]],
  },
  {
    id: "sec_request_valeria_location",
    type: "api-call-service",
    z: TAB_ID,
    name: "Atualizar iPhone Valeria",
    server: SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "notify.send_message",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: ["notify.iphone_de_valeria"],
    labelId: [],
    data: "{\"message\":\"request_location_update\"}",
    dataType: "json",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "notify",
    service: "send_message",
    x: 450,
    y: 760,
    wires: [[]],
  },
  {
    id: "sec_arrival_decision",
    type: "function",
    z: TAB_ID,
    name: "Decidir chegada no escuro",
    func: decisionFunction,
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 530,
    y: 260,
    wires: [["sec_reflector_turn_on", "sec_auto_off_delay"], ["sec_reflector_turn_off"]],
  },
  {
    id: "sec_reflector_turn_on",
    type: "api-call-service",
    z: TAB_ID,
    name: "Ligar refletor_portao_carros",
    server: SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "switch.turn_on",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: ["switch.refletor_portao_carros"],
    labelId: [],
    data: "",
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "switch",
    service: "turn_on",
    x: 840,
    y: 220,
    wires: [[]],
  },
  {
    id: "sec_auto_off_delay",
    type: "delay",
    z: TAB_ID,
    name: "Desligar apos 10 min",
    pauseType: "delay",
    timeout: "10",
    timeoutUnits: "minutes",
    rate: "1",
    nbRateUnits: "1",
    rateUnits: "second",
    randomFirst: "1",
    randomLast: "5",
    randomUnits: "seconds",
    drop: false,
    allowrate: false,
    outputs: 1,
    x: 840,
    y: 280,
    wires: [["sec_auto_off_event"]],
  },
  {
    id: "sec_auto_off_event",
    type: "change",
    z: TAB_ID,
    name: "Timeout seguranca",
    rules: [
      {
        t: "set",
        p: "payload",
        pt: "msg",
        to: '{"event":"turn_off","reason":"timeout_10min","creta":{"state":"home","attributes":{}}}',
        tot: "json",
      },
    ],
    x: 1040,
    y: 320,
    wires: [["sec_arrival_decision"]],
  },
  {
    id: "sec_reflector_turn_off",
    type: "api-call-service",
    z: TAB_ID,
    name: "Desligar refletor_portao_carros",
    server: SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "switch.turn_off",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: ["switch.refletor_portao_carros"],
    labelId: [],
    data: "",
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "switch",
    service: "turn_off",
    x: 830,
    y: 360,
    wires: [[]],
  },
];

const updatedFlows = flows.filter((node) => !nodeIds.has(node.id));
updatedFlows.push(...newNodes);

fs.writeFileSync(flowsUrl, `${JSON.stringify(updatedFlows, null, 4)}\n`);
console.log(`Installed ${newNodes.length} security light nodes on tab ${TAB_ID}.`);
