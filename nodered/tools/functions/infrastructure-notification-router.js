const notification = msg.notification;
if (!notification || !notification.title || !notification.message || !notification.id) {
    node.warn("Notificação de infraestrutura descartada: título, mensagem ou id ausente.");
    return null;
}
return [msg, msg, notification.dismiss_id ? msg : null];
