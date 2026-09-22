msg.payload = { simulated: true, dispatched: false, decision: msg.payload ?? msg.startup_decision ?? "release" };
flow.set("startup_last_dry_run", msg.payload, "memoryOnly");
node.status({ fill: "blue", shape: "dot", text: "TESTE: sem efeito externo" });
return null;
