const messages = msg._light_reconcile?.messages ?? [];
return messages.length ? [messages] : null;
