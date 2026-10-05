// Classify bounded execution metadata. Never expose prompts, chat names or endpoints.
const tasks = { "review-diff": "Revisão de alterações", "summarize-memory": "Resumo de memória", "summarize-document": "Resumo de documento", "summarize-log": "Resumo de logs", "analyze-tests": "Análise de testes", "inspect-files": "Análise de arquivos", "structured_extraction": "Extração estruturada" };
const n = v => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const text = v => typeof v === "string" ? v.replace(/[|<>\r\n`]/g, " ").slice(0, 100) : "—";
msg.report.jobs = (msg.rtx.history || []).filter(job => job && typeof job === "object").slice(0, msg.rtx.policy.history_limit).map(job => {
    const confirmed = job.status === "success" && job.primary_context_used === true && job.quality_accepted === true && job.quality_validation_tokens_measured === true;
    const gross = n(job.gross_useful_context_tokens_avoided), cost = n(job.quality_validation_tokens);
    const net = confirmed && gross !== null && cost !== null ? Math.max(0, gross - cost) : 0;
    const result = job.status === "failed" ? "Falha técnica" : job.status === "discarded" ? (job.discard_reason === "insufficient_net_savings" ? "Descartado: sem ganho líquido" : "Descartado: fidelidade") : confirmed ? "Uso confirmado" : job.status === "success" ? "Uso não confirmado" : "Sem classificação";
    const timestamp = Date.parse(job.finished_at || job.started_at);
    return { at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null, task: tasks[job.task] || text(job.task), model: text(job.model), result, duration: n(job.duration_seconds), net, quality: n(job.quality_score_percent), processor: text(job.processor), gpu_peak: n(job.gpu_peak_percent) };
});
msg.report.history_reason = msg.report.history_status === "unavailable" ? "Histórico sem leitura recente" : msg.report.jobs.length ? "Execuções recentes; somente entregas confirmadas contam economia" : "Nenhuma execução registrada nas últimas 48 horas";
return msg;
