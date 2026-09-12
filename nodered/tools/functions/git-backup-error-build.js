const detail = String(msg.payload ?? "erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 240);
node.error("git_backup_request_failed detail=" + detail, msg);
msg.alert = {
    title: "Falha no backup Git",
    message: "A solicitação de backup não terminou no prazo ou o worker do host ficou indisponível. Verifique o fluxo backup_git e o log seguro do host.",
};
return msg;
