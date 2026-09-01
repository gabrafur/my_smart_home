const TEST_MODE =
    msg._vehicle_primary_remote_command_test === true ||
    msg.payload?.test_mode === true;
const STORE = TEST_MODE ? undefined : "persistent";
const KEY = TEST_MODE
    ? "vehicle_primary_remote_command_monitor_v1__test"
    : "vehicle_primary_remote_command_monitor_v1";

if (msg.payload?.event === "reset") {
    flow.set(KEY, null, STORE);
    node.status({
        fill: "blue",
        shape: "dot",
        text: "TESTE do comando remoto resetado"
    });
    return null;
}

const entity = msg.payload?.entity ?? msg.payload ?? {};
const state = String(entity.state ?? "unknown").toLowerCase();
const attributes = entity.attributes ?? {};
if (state !== "failed") return null;

const preconditions = msg.payload?.preconditions ?? {};
const stateOf = (value) => String(value?.state ?? "unknown").toLowerCase();

const command = String(attributes.command ?? "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "") || "unknown";
const failureStage = String(attributes.failure_stage ?? "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "") || "unknown";
const observedAt = String(
    attributes.failed_at ??
    attributes.updated_at ??
    entity.last_updated ??
    "unknown"
).slice(0, 64);
const incidentKey = [command, failureStage, observedAt].join("|");
const previous = flow.get(KEY, STORE) ?? {};
if (previous.incident_key === incidentKey) return null;

const labels = {
    unlock: "destravar as portas",
    lock: "travar as portas",
    climate_on: "ligar o carro e o ar-condicionado",
    climate_off: "desligar o carro e o ar-condicionado",
    hazard_lights_and_horn: "acionar a buzina e as luzes"
};
const label = labels[command] ?? "executar um comando remoto";
const rawReason = String(attributes.reason ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
const reason = rawReason.slice(0, 280);
const openSignals = [
    ["front_left_door", "porta dianteira esquerda"],
    ["front_right_door", "porta dianteira direita"],
    ["back_left_door", "porta traseira esquerda"],
    ["back_right_door", "porta traseira direita"],
    ["trunk", "porta-malas"]
];
const blockers = [];
if (["lock", "climate_on"].includes(command)) {
    for (const [key, labelText] of openSignals) {
        if (stateOf(preconditions[key]) === "on") {
            blockers.push(`${labelText} aberta`);
        }
    }
}
if (
    ["lock", "climate_on"].includes(command) &&
    stateOf(preconditions.engine) === "on"
) {
    blockers.push("motor ligado");
}
if (
    command === "climate_on" &&
    stateOf(preconditions.lock) === "unlocked"
) {
    blockers.push("portas destravadas");
}

const telemetryAt = Date.parse(preconditions.telemetry?.state ?? "");
const telemetryAgeMinutes = Number.isFinite(telemetryAt)
    ? Math.max(0, Math.round((Date.now() - telemetryAt) / 60000))
    : null;
const formatNumber = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 0
});
let detail;
if (blockers.length) {
    detail =
        " Possível causa detectada na última telemetria: " +
        blockers.join(", ") +
        ".";
    if (telemetryAgeMinutes !== null && telemetryAgeMinutes > 5) {
        detail +=
            " Essa leitura do veículo tinha " +
            formatNumber.format(telemetryAgeMinutes) +
            " min quando a falha foi recebida; confirme fisicamente ou " +
            "atualize os dados antes de repetir.";
    }
} else {
    detail = reason
        ? ` Motivo informado: ${reason}`
        : " O Bluelink não informou um motivo adicional.";
}

flow.set(KEY, {
    version: 1,
    incident_key: incidentKey,
    command,
    failure_stage: failureStage,
    observed_at: observedAt,
    notified_at: Date.now()
}, STORE);

msg._vehicle_primary_remote_command_test = TEST_MODE;
msg.payload = {
    event: "vehicle_remote_command_failed",
    test_mode: TEST_MODE,
    command,
    failure_stage: failureStage,
    observed_at: observedAt,
    side_effect: "notify:resident_primary+persistent_notification"
};
msg.alert = {
    title: TEST_MODE
        ? "TESTE — falha no comando do Creta"
        : "Falha no comando remoto do Creta",
    message:
        `Não foi possível ${label}; o veículo não confirmou a execução.` +
        detail
};
msg.notification = {
    id: "vehicle_primary_remote_command_failed",
    title: msg.alert.title,
    message: msg.alert.message
};

node.status({
    fill: "red",
    shape: "ring",
    text: `falha confirmada: ${command}`
});
node.warn(
    "VEHICLE_PRIMARY_REMOTE_COMMAND_FAILED " +
    `command=${command} stage=${failureStage}`
);
return msg;
