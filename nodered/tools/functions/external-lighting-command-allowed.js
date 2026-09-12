const data = msg._external_command;
msg.delay = Number(data.policy.confirmation_settle_seconds) * 1000;
delete msg.reset;
return msg;
