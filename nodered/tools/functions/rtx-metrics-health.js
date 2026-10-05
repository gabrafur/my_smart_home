// Availability decisions are canonical here; GPU measurements remain observations.
const live = msg.rtx.live;
const attrs = live?.attributes || {};
const states = {
    in_use: ["Em uso", "Há uma tarefa local em execução"],
    available: ["Disponível", "Serviço pronto; nenhuma tarefa local em execução"],
    stale: ["Sem confirmação recente", "A verificação do serviço expirou"],
};
let [label, reason] = states[live?.state] || ["Indisponível", "Serviço local sem disponibilidade confirmada"];
if (!live) [label, reason] = ["Sem sinal", "Não há uma leitura recente da atividade local"];
if (msg.report.host === "offline" && live?.state !== "in_use") [label, reason] = ["Computador desligado", "Computador offline; nenhuma recuperação automática solicitada"];
msg.report.health = { label, reason, model: attrs.model || null, task: attrs.task || null, sampled_at: attrs.sampled_at || null };
const active = live?.state === "in_use";
for (const [key, source] of [["gpu", "gpu_util_percent"], ["vram", "vram_mib"], ["power", "power_watts"]]) {
    const value = attrs[source];
    msg.report.metrics[key] = active && typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
msg.report.health.sample_reason = active ? "Medições da tarefa ativa; valores ausentes ainda não foram amostrados" : "Sem amostra ativa: GPU, VRAM e potência não são medidas de repouso";
return msg;
