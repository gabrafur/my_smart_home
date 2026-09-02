const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

const STATE_KEY = TEST_MODE
    ? "security_light_engine_bypass_enabled__test"
    : "security_light_engine_bypass_enabled";
const PERSISTENT = "persistent";

function getState() {
    return TEST_MODE
        ? flow.get(STATE_KEY)
        : flow.get(STATE_KEY, PERSISTENT);
}

function setState(value) {
    return TEST_MODE
        ? flow.set(STATE_KEY, value)
        : flow.set(STATE_KEY, value, PERSISTENT);
}

const raw = msg.payload?.requested_state ?? msg.payload;
const command = String(raw ?? "").trim().toUpperCase();
const startup = command === "STARTUP";

let enabled;
if (startup) {
    enabled = getState() === true;
    if (getState() === undefined) setState(false);
} else if (["ON", "TRUE", "1"].includes(command)) {
    enabled = true;
} else if (["OFF", "FALSE", "0"].includes(command)) {
    enabled = false;
} else {
    node.warn(
        "iluminacao_seguranca: comando inválido para o bypass manual do motor"
    );
    return null;
}

const previous = getState() === true;
setState(enabled);

if (previous !== enabled || startup) {
    node.status({
        fill: enabled ? "yellow" : "grey",
        shape: enabled ? "dot" : "ring",
        text: enabled
            ? "bypass manual do motor ATIVO"
            : "bypass manual do motor desligado"
    });
}

if (!TEST_MODE && previous !== enabled) {
    if (enabled) {
        node.warn(
            "iluminacao_seguranca: bypass manual do motor ativado; " +
            "só será aplicado enquanto a telemetria do motor estiver não confiável"
        );
    } else {
        node.log?.(
            "iluminacao_seguranca: bypass manual do motor desativado"
        );
    }
}

const reevaluate = {
    payload: {
        contract: "security.engine-bypass.v1",
        kind: "engine_bypass_context",
        source: TEST_MODE ? "manual_test" : "dashboard",
        enabled,
        updated_at: Date.now(),
        test_mode: TEST_MODE
    }
};

if (TEST_MODE) {
    reevaluate._location_test = true;
    reevaluate._location_test_case =
        msg._location_test_case ??
        msg.payload?.test_case ??
        "engine_bypass";
    reevaluate.payload.test_case = reevaluate._location_test_case;
    return [null, reevaluate];
}

const discovery = {
    topic: "homeassistant/switch/vehicle_primary_engine_bypass/config",
    retain: true,
    qos: 1,
    payload: JSON.stringify({
        name: "Bypass do motor para iluminação de chegada",
        unique_id: "vehicle_primary_engine_bypass",
        object_id: "vehicle_primary_engine_bypass",
        state_topic: "homeassistant/vehicle_primary/engine_bypass/state",
        command_topic: "homeassistant/vehicle_primary/engine_bypass/set",
        payload_on: "ON",
        payload_off: "OFF",
        state_on: "ON",
        state_off: "OFF",
        icon: "mdi:car-light-alert",
        device: {
            identifiers: ["vehicle_primary_bluelink"],
            name: "vehicle_primary",
            manufacturer: "Hyundai"
        }
    })
};

const stateMessage = {
    topic: "homeassistant/vehicle_primary/engine_bypass/state",
    retain: true,
    qos: 1,
    payload: enabled ? "ON" : "OFF"
};

return [[discovery, stateMessage], reevaluate];
