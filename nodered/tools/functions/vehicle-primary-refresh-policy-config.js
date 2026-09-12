const CONFIG_KEY = "vehicle_primary_refresh_policy_config_v1";
const PERSISTENT = "persistent";

const limits = {
    away_interval_minutes: { min: 15, max: 1440, integer: false },
    approaching_interval_minutes: { min: 5, max: 1440, integer: false },
    home_interval_minutes: { min: 15, max: 1440, integer: false },
    quiet_start_hour: { min: 0, max: 23, integer: true },
    quiet_end_hour: { min: 1, max: 24, integer: true },
    in_flight_lease_seconds: { min: 30, max: 600, integer: true },
    cache_probe_settle_seconds: { min: 5, max: 120, integer: true },
    provider_backoff_max_hours: { min: 1, max: 24, integer: false },
    semantic_evidence_window_minutes: { min: 5, max: 60, integer: false },
    unknown_location_start_hour: { min: 0, max: 23, integer: true },
    unknown_location_end_hour: { min: 1, max: 24, integer: true }
};

const key = String(msg.topic ?? "");
const rule = limits[key];
const value = Number(msg.payload);

if (
    !rule ||
    !Number.isFinite(value) ||
    value < rule.min ||
    value > rule.max ||
    (rule.integer && !Number.isInteger(value))
) {
    node.error(
        `Política de refresh inválida: ${key || "campo ausente"}=${msg.payload}`,
        msg
    );
    return null;
}

const current = flow.get(CONFIG_KEY, PERSISTENT);
const config = current && current.version === 1
    ? { ...current }
    : { version: 1 };

config[key] = value;
config.updated_at = Date.now();
config.complete = Object.keys(limits).every(
    (item) => Number.isFinite(Number(config[item]))
);

flow.set(CONFIG_KEY, config, PERSISTENT);

node.status({
    fill: config.complete ? "green" : "yellow",
    shape: config.complete ? "dot" : "ring",
    text: config.complete
        ? `${config.away_interval_minutes} min fora | ` +
          `${config.approaching_interval_minutes} min near_home | ` +
          `${config.home_interval_minutes} min casa | ` +
          `${config.quiet_start_hour}h–${config.quiet_end_hour}h | ` +
          `lease ${config.in_flight_lease_seconds}s`
        : "aguardando todos os valores"
});

return null;
