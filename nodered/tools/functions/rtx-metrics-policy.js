// Only validated, visible parameters replace the last valid policy.
const limits = { usage_max_age_s: [15, 300], live_max_age_s: [5, 60], history_max_age_s: [30, 600], host_max_age_s: [35, 300], history_limit: [1, 30] };
const policy = msg.payload;
if (!policy || Object.entries(limits).some(([key, [min, max]]) => !Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max)) {
    node.warn("Política RTX inválida; preservada a última configuração válida");
    return null;
}
flow.set(msg.test_mode === true ? "rtx_metrics_test_policy" : "rtx_metrics_policy", policy);
node.status({ fill: "green", shape: "dot", text: "parâmetros válidos" });
return msg;
