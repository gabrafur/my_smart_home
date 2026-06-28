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
  "sec_engine_off_changed",
  "sec_creta_locked_changed",
  "sec_arrival_decision",
  "sec_reflector_turn_on",
  "sec_auto_off_delay",
  "sec_auto_off_event",
  "sec_reflector_turn_off",
]);

const jsonata = `(
  {
    "event": "arrival_check",
    "sun": $entities("sun.sun"),
    "gabriel": $entities("device_tracker.iphone_de_gabriel_furlan"),
    "valeria": $entities("device_tracker.iphone_de_valeria"),
    "creta": $entities("device_tracker.creta_location"),
    "creta_lock": $entities("lock.creta_door_lock")
  }
)`;

const decisionFunction = `const HOME_LAT = ${HOME_LAT};
const HOME_LON = ${HOME_LON};
const event = msg.payload?.event;

const ACTIVE_KEY = "refletor_portao_carros_active_by_arrival";
const ARMED_KEY = "refletor_portao_carros_arrival_armed_entities";
const ARM_DISTANCE_M = 100;
const PHONE_ARRIVAL_DISTANCE_M = 45;
const CRETA_ARRIVAL_DISTANCE_M = 90;

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
        latitude: lat,
        longitude: lon,
        gps_accuracy: Number.isFinite(gpsAccuracy) ? gpsAccuracy : null,
        distance_m: valid ? Math.round(distanceMeters(HOME_LAT, HOME_LON, lat, lon)) : null,
    };
}

function isAway(item) {
    return item.distance_m !== null && (item.distance_m > ARM_DISTANCE_M || item.state === "not_home");
}

function isNear(item, distance) {
    return item.distance_m !== null && item.distance_m <= distance;
}

if (event === "turn_off") {
    if (flow.get(ACTIVE_KEY)) {
        flow.set(ACTIVE_KEY, false);
        flow.set(ARMED_KEY, {});
        msg.payload = { reason: msg.payload.reason ?? "arrival_finished" };
        return [null, msg];
    }
    return [null, null];
}

if (event !== "arrival_check") {
    return [null, null];
}

const gabriel = position(msg.payload.gabriel);
const valeria = position(msg.payload.valeria);
const creta = position(msg.payload.creta);
const sunBelow = msg.payload.sun?.state === "below_horizon";
const lockState = msg.payload.creta_lock?.state;
const armedEntities = flow.get(ARMED_KEY) ?? {};

msg.payload = {
    event,
    sun_below_horizon: sunBelow,
    gabriel,
    valeria,
    creta,
    creta_lock: lockState,
    arriving: [],
};

for (const [name, item] of Object.entries({ gabriel, valeria, creta })) {
    if (isAway(item)) {
        armedEntities[name] = true;
    }
}

if (armedEntities.gabriel && isNear(gabriel, PHONE_ARRIVAL_DISTANCE_M)) {
    msg.payload.arriving.push("gabriel");
}
if (armedEntities.valeria && isNear(valeria, PHONE_ARRIVAL_DISTANCE_M)) {
    msg.payload.arriving.push("valeria");
}
if (armedEntities.creta && isNear(creta, CRETA_ARRIVAL_DISTANCE_M)) {
    msg.payload.arriving.push("creta");
}

flow.set(ARMED_KEY, armedEntities);

const active = flow.get(ACTIVE_KEY) === true;
msg.payload.should_turn_on = sunBelow && msg.payload.arriving.length > 0;

if (!active && msg.payload.should_turn_on) {
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
    name: "Liga refletor_portao_carros no escuro quando alguem esta chegando",
    info: "Calcula distancia ate Casa Vitoria usando lat/lon dos device_trackers. Arma Gabriel, Valeria e Creta individualmente quando ficam a mais de 100 m ou not_home; liga quando qualquer um deles volta para perto de casa apos o por do sol. Desliga ao travar o Creta ou por timeout.",
    x: 560,
    y: 60,
    wires: [],
  },
  {
    id: "sec_arrival_state_changed",
    type: "server-state-changed",
    z: TAB_ID,
    name: "Chegada apos por do sol",
    server: SERVER_ID,
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: {
      entity: [
        "device_tracker.iphone_de_gabriel_furlan",
        "device_tracker.iphone_de_valeria",
        "device_tracker.creta_location",
        "lock.creta_door_lock",
        "sun.sun",
      ],
      substring: [],
      regex: [],
    },
    outputInitially: false,
    stateType: "str",
    ifState: "",
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: "0",
    forType: "num",
    forUnits: "minutes",
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: jsonata,
        valueType: "jsonata",
      },
    ],
    x: 220,
    y: 140,
    wires: [["sec_arrival_decision"]],
  },
  {
    id: "sec_engine_off_changed",
    type: "server-state-changed",
    z: TAB_ID,
    name: "Creta desligou",
    server: SERVER_ID,
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: {
      entity: ["binary_sensor.creta_engine"],
      substring: [],
      regex: [],
    },
    outputInitially: false,
    stateType: "str",
    ifState: "off",
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: "0",
    forType: "num",
    forUnits: "minutes",
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: "{\"event\":\"turn_off\",\"reason\":\"creta_engine_off\"}",
        valueType: "json",
      },
    ],
    x: 190,
    y: 240,
    wires: [["sec_arrival_decision"]],
  },
  {
    id: "sec_creta_locked_changed",
    type: "server-state-changed",
    z: TAB_ID,
    name: "Creta travou",
    server: SERVER_ID,
    version: 6,
    outputs: 1,
    exposeAsEntityConfig: "",
    entities: {
      entity: ["lock.creta_door_lock"],
      substring: [],
      regex: [],
    },
    outputInitially: false,
    stateType: "str",
    ifState: "locked",
    ifStateType: "str",
    ifStateOperator: "is",
    outputOnlyOnStateChange: true,
    for: "0",
    forType: "num",
    forUnits: "minutes",
    ignorePrevStateNull: false,
    ignorePrevStateUnknown: false,
    ignorePrevStateUnavailable: false,
    ignoreCurrentStateUnknown: true,
    ignoreCurrentStateUnavailable: true,
    outputProperties: [
      {
        property: "payload",
        propertyType: "msg",
        value: "{\"event\":\"turn_off\",\"reason\":\"creta_locked\"}",
        valueType: "json",
      },
    ],
    x: 180,
    y: 300,
    wires: [["sec_arrival_decision"]],
  },
  {
    id: "sec_arrival_decision",
    type: "function",
    z: TAB_ID,
    name: "Controlar refletor chegada",
    func: decisionFunction,
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 500,
    y: 180,
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
    x: 790,
    y: 140,
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
    x: 800,
    y: 190,
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
        to: "{\"event\":\"turn_off\",\"reason\":\"timeout_10min\"}",
        tot: "json",
      },
    ],
    x: 1010,
    y: 190,
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
    x: 800,
    y: 240,
    wires: [[]],
  },
];

const filtered = flows.filter((node) => !nodeIds.has(node.id));
filtered.push(...newNodes);
fs.writeFileSync(flowsUrl, `${JSON.stringify(filtered, null, 2)}\n`);

console.log(`Installed ${newNodes.length} nodes in iluminacao_seguranca.`);
