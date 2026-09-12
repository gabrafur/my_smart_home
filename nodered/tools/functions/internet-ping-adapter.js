const childProcess = global.get("childProcess");
const lockKey = "internet_ping_cycle_running";
if (!childProcess || typeof childProcess.execFile !== "function") {
    node.error("settings.js não expôs childProcess no contexto global.", msg);
    node.done();
    return null;
}
if (flow.get(lockKey, "memoryOnly") === true) {
    node.status({ fill: "yellow", shape: "ring", text: "ciclo anterior ainda ativo" });
    node.done();
    return null;
}

flow.set(lockKey, true, "memoryOnly");
const startedAt = Date.now();
const ping = (target) => new Promise((resolve) => {
    const finish = (error, stdout = "", stderr = "") => resolve({
        name: target.name,
        address: target.address,
        ok: !error,
        duration_ms: Date.now() - startedAt,
        error: error ? String(error.code || error.message || stderr || "ping failed") : null,
        output: String(stdout || "").trim().slice(-160)
    });
    try {
        childProcess.execFile(
            "/bin/ping",
            ["-n", "-c", "1", "-W", String(msg.policy.ping_timeout_s), target.address],
            { timeout: msg.policy.exec_timeout_ms, windowsHide: true },
            finish
        );
    } catch (error) {
        finish(error);
    }
});

Promise.all(msg.policy.targets.map(ping))
    .then((results) => node.send({
        ...msg,
        topic: "infrastructure/internet/ping-cycle",
        payload: { checked_at: new Date().toISOString(), duration_ms: Date.now() - startedAt, results }
    }))
    .catch((error) => node.error("Falha inesperada no ciclo de ping: " + error.message, msg))
    .finally(() => {
        flow.set(lockKey, false, "memoryOnly");
        node.done();
    });
return undefined;
