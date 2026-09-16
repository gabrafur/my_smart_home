const reason = String(msg.payload?.reason ?? "unknown_failure");
const details = {
    network_unavailable: "A conexão com o GitHub estava indisponível.",
    authentication_or_access: "O GitHub recusou a autenticação ou o acesso ao repositório.",
    remote_diverged: "A branch local divergiu da branch remota.",
    validation_failed: "A validação obrigatória anterior ao push falhou.",
    security_scan_failed: "A verificação de segurança bloqueou o commit.",
    remote_operation_failed: "A operação remota do Git falhou sem uma categoria mais específica.",
    unknown_failure: "O worker terminou com uma falha não classificada."
};
msg.alert = {
    title: "Falha no backup Git",
    message: `${details[reason] ?? details.unknown_failure} O commit local foi preservado; verifique o fluxo backup_git e o log seguro do host.`,
};
return msg;
