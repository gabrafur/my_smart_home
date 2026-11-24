// One planned Home Assistant stop for the integration updaters.
// Docker's default 10 s kills Home Assistant before the recorder closes SQLite
// ("could not validate that the sqlite3 database was shutdown cleanly").
export const STOP_TIMEOUT_SECONDS = 120;

export const STOP_ARGS = Object.freeze([
  "compose", "stop", "--timeout", String(STOP_TIMEOUT_SECONDS), "homeassistant",
]);

// The start automation asks whether the restart was planned. Replace that same
// notice (Home Assistant closes it after one hour) with the actual reason.
export function plannedRestartNotice({ reason, stopSeconds, now = new Date() }) {
  const text = String(reason ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 120);
  if (!text) throw new Error("planned restart reason is required");
  const seconds = Math.round(Number(stopSeconds));
  const stop = !Number.isFinite(seconds) ? "" : seconds < STOP_TIMEOUT_SECONDS
    ? ` Parada concluída em ${seconds} s, dentro do prazo.`
    : ` A parada passou do prazo de ${STOP_TIMEOUT_SECONDS} s e foi forçada.`;
  return {
    title: "Home Assistant iniciado",
    message: `Reinício planejado: ${text}.${stop} Registrado em ${now.toISOString()}.`,
    notification_id: "raspberry_pi_home_assistant_started",
  };
}

// Best effort: a missing notice never fails or repeats an update.
export async function announcePlannedRestart(callService, details) {
  try {
    await callService("/api/services/persistent_notification/create", plannedRestartNotice(details));
    return true;
  } catch {
    return false;
  }
}
