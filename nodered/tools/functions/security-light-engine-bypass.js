const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

const STATE_KEY = TEST_MODE
    ? "security_light_engine_bypass_enabled__test"
    : "security_light_engine_bypass_enabled";
const AUTOMATIC_KEY = TEST_MODE
    ? "security_light_engine_bypass_automatic__test"
    : "security_light_engine_bypass_automatic";
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

function getAutomatic() {
    return TEST_MODE
        ? flow.get(AUTOMATIC_KEY) === true
        : flow.get(AUTOMATIC_KEY, PERSISTENT) === true;
}

function setAutomatic(value) {
    return TEST_MODE
        ? flow.set(AUTOMATIC_KEY, value)
        : flow.set(AUTOMATIC_KEY, value, PERSISTENT);
}

let commandPayload = msg.payload;
if (
    typeof commandPayload === "string" &&
    commandPayload.trim().startsWith("{")
) {
    try {
        commandPayload = JSON.parse(commandPayload);
    } catch (_err) {
        commandPayload = msg.payload;
    }
}
const raw = commandPayload?.requested_state ?? commandPayload;
const command = String(raw ?? "").trim().toUpperCase();
const startup = command === "STARTUP";
const source = String(commandPayload?.source ?? "dashboard");
const providerActivation = source === "provider_backoff";
const providerRecovery = source === "provider_recovered";

let enabled;
if (startup) {
    enabled = getState() === true;
    if (getState() === undefined) setState(false);
} else if (providerActivation) {
    const wasEnabled = getState() === true;
    enabled = true;
    // Se já estava ON, foi uma escolha manual e não deve ser desfeita pela
    // recuperação posterior da API.
    if (!wasEnabled) setAutomatic(true);
} else if (providerRecovery) {
    if (!getAutomatic()) return null;
    enabled = false;
    setAutomatic(false);
} else if (["ON", "TRUE", "1"].includes(command)) {
    enabled = true;
    setAutomatic(false);
} else if (["OFF", "FALSE", "0"].includes(command)) {
    enabled = false;
    setAutomatic(false);
} else {
    node.warn(
        "iluminacao_seguranca: comando inválido para o bypass manual do motor"
    );
    return null;
}

const previous = getState() === true;
setState(enabled);
const automatic = getAutomatic();

if (previous !== enabled || startup) {
    node.status({
        fill: enabled ? "yellow" : "grey",
        shape: enabled ? "dot" : "ring",
        text: enabled
            ? (automatic
                ? "bypass automático: API indisponível"
                : "bypass manual do motor ATIVO")
            : "bypass manual do motor desligado"
    });
}

if (!TEST_MODE && previous !== enabled) {
    if (enabled) {
        node.warn(
            "iluminacao_seguranca: bypass do motor ativado" +
            (automatic ? " automaticamente pela indisponibilidade da API; " : "; ") +
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
        source: TEST_MODE ? "manual_test" : source,
        enabled,
        automatic,
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
