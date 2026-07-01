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
  "sec_refresh_context_snapshot",
  "sec_refresh_anyone_away",
  "sec_force_refresh_creta",
  "sec_refresh_creta_entities",
  "sec_request_gabriel_location",
  "sec_request_valeria_location",
  "sec_arrival_decision",
  "sec_prepare_arrival_context",
  "sec_turn_off_creta_home",
  "sec_turn_off_if_active",
  "sec_update_arming_context",
  "sec_update_arming_location",
  "sec_notify_valeria_approaching",
  "sec_detect_arriving_source",
  "sec_detect_arriving_person",
  "sec_route_arrival_source",
  "sec_check_dark",
  "sec_check_engine_on",
  "sec_check_reflector_inactive",
  "sec_mark_reflector_active",
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
    wires: [["sec_prepare_arrival_context"]],
  };
}

const prepareContextFunction = `const HOME_LAT = ${HOME_LAT};
const HOME_LON = ${HOME_LON};
const event = msg.payload?.event;

const ACTIVE_KEY = "refletor_portao_carros_active_by_arrival";
const ARMED_KEY = "refletor_portao_carros_arrival_armed_entities";
const ARRIVAL_DISTANCE_M = 50;
const MAX_GPS_ACCURACY_M = 100;

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
    const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon);
    const hasGpsAccuracy = Number.isFinite(gpsAccuracy);
    const reliableCoordinates = hasCoordinates && (!hasGpsAccuracy || gpsAccuracy <= MAX_GPS_ACCURACY_M);

    return {
        entity_id: entity?.entity_id,
        state: entity?.state,
        latitude: hasCoordinates ? lat : null,
        longitude: hasCoordinates ? lon : null,
        gps_accuracy: hasGpsAccuracy ? gpsAccuracy : null,
        location_reliable: reliableCoordinates,
        distance_m: reliableCoordinates ? Math.round(distanceMeters(HOME_LAT, HOME_LON, lat, lon)) : null,
    };
}

function isHome(item) {
    if (item.distance_m !== null) {
        return item.distance_m <= ARRIVAL_DISTANCE_M;
    }
    if (item.gps_accuracy !== null && item.gps_accuracy > MAX_GPS_ACCURACY_M) {
        return false;
    }
    return item.state === "home";
}

const gabriel = position(msg.payload?.gabriel);
const valeria = position(msg.payload?.valeria);
const creta = position(msg.payload?.creta);
const sunBelow = msg.payload?.sun?.state === "below_horizon";
const engineOn = msg.payload?.creta_engine?.state === "on";
const lockState = msg.payload?.creta_lock?.state;

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
    active: flow.get(ACTIVE_KEY) === true,
    armed: flow.get(ARMED_KEY) ?? {},
    arriving: [],
};

if (event === "turn_off") {
    return [msg, null, null];
}
if (event === "context_update") {
    return [null, msg, null];
}
if (event === "location_update") {
    return [null, null, msg];
}
return [null, null, null];`;

const updateArmingContextFunction = `const ARMED_KEY = "refletor_portao_carros_arrival_armed_entities";
const ARM_DISTANCE_M = 100;
const ARRIVAL_DISTANCE_M = 50;
const MAX_GPS_ACCURACY_M = 100;

function isAway(item) {
    if (item && item.distance_m !== null) {
        return item.distance_m > ARM_DISTANCE_M;
    }
    return item?.state === "not_home";
}

function isHome(item) {
    if (item && item.distance_m !== null) {
        return item.distance_m <= ARRIVAL_DISTANCE_M;
    }
    if (item?.gps_accuracy !== null && item?.gps_accuracy > MAX_GPS_ACCURACY_M) {
        return false;
    }
    return item?.state === "home";
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

const armedEntities = msg.payload.armed ?? {};
const trackedPeople = {
    gabriel: msg.payload.gabriel,
    valeria: msg.payload.valeria,
    creta: msg.payload.creta,
};

updateAwayArming(armedEntities, trackedPeople);
clearCurrentHomeArming(armedEntities, trackedPeople);
flow.set(ARMED_KEY, armedEntities);

return null;`;

const updateArmingLocationFunction = `const ARMED_KEY = "refletor_portao_carros_arrival_armed_entities";
const VALERIA_APPROACH_NOTIFY_KEY = "valeria_approaching_gabriel_notified";
const ARM_DISTANCE_M = 100;
const VALERIA_APPROACH_DISTANCE_M = 700;
const VALERIA_APPROACH_RESET_DISTANCE_M = 1000;

function isAway(item) {
    if (item && item.distance_m !== null) {
        return item.distance_m > ARM_DISTANCE_M;
    }
    return item?.state === "not_home";
}

const armedEntities = msg.payload.armed ?? {};
for (const [name, item] of Object.entries({
    gabriel: msg.payload.gabriel,
    valeria: msg.payload.valeria,
    creta: msg.payload.creta,
})) {
    if (isAway(item)) {
        armedEntities[name] = true;
    }
}

msg.payload.armed = armedEntities;
flow.set(ARMED_KEY, armedEntities);

const valeria = msg.payload.valeria;
let notify = null;
if (valeria?.distance_m !== null && valeria.distance_m > VALERIA_APPROACH_RESET_DISTANCE_M) {
    flow.set(VALERIA_APPROACH_NOTIFY_KEY, false);
}

if (
    msg.payload.source === "valeria" &&
    valeria?.distance_m !== null &&
    valeria.distance_m <= VALERIA_APPROACH_DISTANCE_M &&
    valeria.distance_m > 50 &&
    flow.get(VALERIA_APPROACH_NOTIFY_KEY) !== true
) {
    flow.set(VALERIA_APPROACH_NOTIFY_KEY, true);
    notify = {
        payload: {
            valeria_distance_m: valeria.distance_m,
        },
    };
}

return [msg, notify];`;

const detectArrivingFunction = `const ARMED_KEY = "refletor_portao_carros_arrival_armed_entities";
const ARRIVAL_DISTANCE_M = 50;
const MAX_GPS_ACCURACY_M = 100;

function isHome(item) {
    if (item && item.distance_m !== null) {
        return item.distance_m <= ARRIVAL_DISTANCE_M;
    }
    if (item?.gps_accuracy !== null && item?.gps_accuracy > MAX_GPS_ACCURACY_M) {
        return false;
    }
    return item?.state === "home";
}

const trackedPeople = {
    gabriel: msg.payload.gabriel,
    valeria: msg.payload.valeria,
    creta: msg.payload.creta,
};
const source = msg.payload.source;
const sourcePosition = trackedPeople[source];
const armedEntities = msg.payload.armed ?? {};

if (!sourcePosition || !isHome(sourcePosition)) {
    flow.set(ARMED_KEY, armedEntities);
    return null;
}

if (armedEntities[source]) {
    msg.payload.arriving = [source];
    msg.payload.arrival_source_type = source === "creta" ? "creta" : "person";
}
armedEntities[source] = false;
msg.payload.armed = armedEntities;
flow.set(ARMED_KEY, armedEntities);

return msg.payload.arriving.length > 0 ? msg : null;`;

const checkEngineOrCretaNearbyFunction = `const CRETA_APPROACH_DISTANCE_M = 700;

if (msg.payload?.creta_engine_on === true) {
    msg.payload.engine_gate = "engine_on";
    return msg;
}

const creta = msg.payload?.creta;
const cretaWasAway = msg.payload?.armed?.creta === true;
const cretaDistance = creta?.distance_m;
const cretaNearby = cretaDistance !== null && cretaDistance <= CRETA_APPROACH_DISTANCE_M;

if (cretaWasAway && cretaNearby) {
    msg.payload.engine_gate = "creta_nearby_fallback";
    msg.payload.reason = "arriving_after_dark_creta_nearby";
    return msg;
}

return null;`;

const turnOffIfActiveFunction = `const ACTIVE_KEY = "refletor_portao_carros_active_by_arrival";
const ARMED_KEY = "refletor_portao_carros_arrival_armed_entities";

const active = msg.payload?.active ?? flow.get(ACTIVE_KEY) === true;

if (!active) {
    return null;
}

flow.set(ACTIVE_KEY, false);
flow.set(ARMED_KEY, {});
return msg;`;

const markActiveFunction = `const ACTIVE_KEY = "refletor_portao_carros_active_by_arrival";
flow.set(ACTIVE_KEY, true);
msg.payload.reason = "arriving_after_dark";
return msg;`;

const refreshAnyoneAwayFunction = `const HOME_LAT = ${HOME_LAT};
const HOME_LON = ${HOME_LON};
const ARM_DISTANCE_M = 100;
const MAX_GPS_ACCURACY_M = 100;

function distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceFromHome(entity) {
    const attrs = entity?.attributes ?? {};
    const lat = Number(attrs.latitude);
    const lon = Number(attrs.longitude);
    const gpsAccuracy = Number(attrs.gps_accuracy);
    const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon);
    const hasGpsAccuracy = Number.isFinite(gpsAccuracy);
    const reliableCoordinates = hasCoordinates && (!hasGpsAccuracy || gpsAccuracy <= MAX_GPS_ACCURACY_M);
    return reliableCoordinates ? Math.round(distanceMeters(HOME_LAT, HOME_LON, lat, lon)) : null;
}

function isAway(entity) {
    const distance = distanceFromHome(entity);
    if (distance !== null) {
        return distance > ARM_DISTANCE_M;
    }
    return entity?.state === "not_home";
}

const awayEntities = [];
for (const [name, entity] of Object.entries({
    gabriel: msg.payload?.gabriel,
    valeria: msg.payload?.valeria,
    creta: msg.payload?.creta,
})) {
    if (isAway(entity)) {
        awayEntities.push(name);
    }
}

msg.payload.refresh_allowed = awayEntities.length > 0;
msg.payload.refresh_away_entities = awayEntities;

return [msg, awayEntities.length > 0 ? msg : null];`;

const newNodes = [
  {
    id: "sec_comment_arrival_light",
    type: "comment",
    z: TAB_ID,
    name: "Liga refletor_portao_carros somente quando a chegada acontece no escuro",
    info: "Localizacao de Gabriel e Valeria aciona a luz quando alguem armado volta para ate 50 m de casa durante a noite e com o motor do Creta ligado. Como fallback, se o Creta estava fora e volta para ate 50 m de casa durante a noite, tambem liga mesmo que o sensor do motor nao tenha atualizado. A rota de pessoa tambem aceita fallback quando o Creta estava armado como fora e ja aparece a ate 700 m de casa, cobrindo atraso da integracao do carro. O por do sol e a trava do Creta apenas atualizam contexto; eles nao reaproveitam chegada antiga nem ligam a luz sozinhos. Gabriel, Valeria e Creta armam ao ficar a mais de 100 m de casa. Creta desligou/travou so desliga o refletor se o Creta estiver em casa.",
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
    info: "Reavalia o contexto a cada 10 minutos. So forca update_entity nas entidades Kia/Hyundai e envia request_location_update para os iPhones quando Gabriel, Valeria ou Creta estiverem fora de casa.",
    x: 620,
    y: 680,
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
    x: 180,
    y: 760,
    wires: [["sec_refresh_context_snapshot"]],
  },
  {
    id: "sec_refresh_context_snapshot",
    type: "api-current-state",
    z: TAB_ID,
    name: "Reavaliar armado atual",
    server: SERVER_ID,
    version: 3,
    outputs: 1,
    halt_if: "",
    halt_if_type: "str",
    halt_if_compare: "is",
    entity_id: "sun.sun",
    state_type: "str",
    blockInputOverrides: false,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: entitiesJsonata("context_update", "refresh"),
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
    x: 460,
    y: 720,
    wires: [["sec_refresh_anyone_away"]],
  },
  {
    id: "sec_refresh_anyone_away",
    type: "function",
    z: TAB_ID,
    name: "Gabriel/Valeria/Creta fora?",
    func: refreshAnyoneAwayFunction,
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 760,
    y: 720,
    wires: [
      ["sec_prepare_arrival_context"],
      ["sec_force_refresh_creta", "sec_refresh_creta_entities", "sec_request_gabriel_location", "sec_request_valeria_location"],
    ],
  },
  {
    id: "sec_force_refresh_creta",
    type: "api-call-service",
    z: TAB_ID,
    name: "Forcar refresh Creta",
    server: SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "button.press",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: ["button.creta_force_refresh"],
    labelId: [],
    data: "",
    dataType: "jsonata",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "button",
    service: "press",
    x: 1080,
    y: 780,
    wires: [[]],
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
    entityId: [],
    labelId: [],
    data: JSON.stringify({
      entity_id: [
        "device_tracker.creta_location",
        "binary_sensor.creta_engine",
        "lock.creta_door_lock",
        "device_tracker.iphone_de_gabriel_furlan",
        "device_tracker.iphone_de_valeria",
      ],
    }),
    dataType: "json",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "homeassistant",
    service: "update_entity",
    x: 1080,
    y: 840,
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
    x: 1100,
    y: 900,
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
    x: 1100,
    y: 960,
    wires: [[]],
  },
  {
    id: "sec_prepare_arrival_context",
    type: "function",
    z: TAB_ID,
    name: "Preparar estados e distancias",
    func: prepareContextFunction,
    outputs: 3,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 520,
    y: 300,
    wires: [
      ["sec_turn_off_creta_home"],
      ["sec_update_arming_context"],
      ["sec_update_arming_location"],
    ],
  },
  {
    id: "sec_turn_off_creta_home",
    type: "switch",
    z: TAB_ID,
    name: "Creta esta em casa?",
    property: "payload.creta_home",
    propertyType: "msg",
    rules: [{ t: "true" }],
    checkall: "true",
    repair: false,
    outputs: 1,
    x: 820,
    y: 560,
    wires: [["sec_turn_off_if_active"]],
  },
  {
    id: "sec_turn_off_if_active",
    type: "function",
    z: TAB_ID,
    name: "Desligar se refletor ativo",
    func: turnOffIfActiveFunction,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1120,
    y: 560,
    wires: [["sec_reflector_turn_off"]],
  },
  {
    id: "sec_update_arming_context",
    type: "function",
    z: TAB_ID,
    name: "Atualizar armado por contexto",
    func: updateArmingContextFunction,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 820,
    y: 220,
    wires: [[]],
  },
  {
    id: "sec_update_arming_location",
    type: "function",
    z: TAB_ID,
    name: "Atualizar armado por localizacao",
    func: updateArmingLocationFunction,
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 820,
    y: 380,
    wires: [["sec_detect_arriving_source"], ["sec_notify_valeria_approaching"]],
  },
  {
    id: "sec_notify_valeria_approaching",
    type: "api-call-service",
    z: TAB_ID,
    name: "Avisar Gabriel: Valeria aproximando",
    server: SERVER_ID,
    version: 7,
    debugenabled: false,
    action: "notify.send_message",
    floorId: [],
    areaId: [],
    deviceId: [],
    entityId: ["notify.iphone_de_gabriel_furlan"],
    labelId: [],
    data: "{\"title\":\"Casa inteligente\",\"message\":\"Valeria esta se aproximando de casa.\"}",
    dataType: "json",
    mergeContext: "",
    mustacheAltTags: false,
    outputProperties: [],
    queue: "none",
    blockInputOverrides: true,
    domain: "notify",
    service: "send_message",
    x: 1120,
    y: 460,
    wires: [[]],
  },
  {
    id: "sec_detect_arriving_source",
    type: "function",
    z: TAB_ID,
    name: "Gabriel/Valeria/Creta chegou <= 50m?",
    func: detectArrivingFunction,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1120,
    y: 380,
    wires: [["sec_check_dark"]],
  },
  {
    id: "sec_check_dark",
    type: "switch",
    z: TAB_ID,
    name: "Esta escuro?",
    property: "payload.sun_below_horizon",
    propertyType: "msg",
    rules: [{ t: "true" }],
    checkall: "true",
    repair: false,
    outputs: 1,
    x: 1400,
    y: 380,
    wires: [["sec_route_arrival_source"]],
  },
  {
    id: "sec_route_arrival_source",
    type: "switch",
    z: TAB_ID,
    name: "Chegada pessoa ou Creta?",
    property: "payload.arrival_source_type",
    propertyType: "msg",
    rules: [{ t: "eq", v: "person", vt: "str" }, { t: "eq", v: "creta", vt: "str" }],
    checkall: "true",
    repair: false,
    outputs: 2,
    x: 1640,
    y: 380,
    wires: [["sec_check_engine_on"], ["sec_check_reflector_inactive"]],
  },
  {
    id: "sec_check_engine_on",
    type: "function",
    z: TAB_ID,
    name: "Motor ligado ou Creta aproximando?",
    func: checkEngineOrCretaNearbyFunction,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1900,
    y: 300,
    wires: [["sec_check_reflector_inactive"]],
  },
  {
    id: "sec_check_reflector_inactive",
    type: "switch",
    z: TAB_ID,
    name: "Refletor ainda inativo?",
    property: "payload.active",
    propertyType: "msg",
    rules: [{ t: "false" }],
    checkall: "true",
    repair: false,
    outputs: 1,
    x: 2160,
    y: 380,
    wires: [["sec_mark_reflector_active"]],
  },
  {
    id: "sec_mark_reflector_active",
    type: "function",
    z: TAB_ID,
    name: "Marcar ativo por chegada",
    func: markActiveFunction,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 2420,
    y: 380,
    wires: [["sec_reflector_turn_on", "sec_auto_off_delay"]],
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
    x: 2700,
    y: 320,
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
    x: 2700,
    y: 420,
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
    x: 840,
    y: 640,
    wires: [["sec_turn_off_if_active"]],
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
    x: 1400,
    y: 560,
    wires: [[]],
  },
];

const updatedFlows = flows.filter((node) => !nodeIds.has(node.id));
updatedFlows.push(...newNodes);

fs.writeFileSync(flowsUrl, `${JSON.stringify(updatedFlows, null, 4)}\n`);
console.log(`Installed ${newNodes.length} security light nodes on tab ${TAB_ID}.`);
