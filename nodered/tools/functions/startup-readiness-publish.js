// The test branch is separated in the canvas before this shared production write.
global.set("startup_readiness_v1", msg.payload, "memoryOnly");
msg.topic = "nodered/infrastructure/startup/state";
msg.payload = JSON.stringify(msg.payload);
return msg;
