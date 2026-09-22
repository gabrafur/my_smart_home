flow.set("global_observer_diagnostic_last_test", {
    record: msg._observer_diagnostic_record, simulated: true, dispatched: false
}, "memoryOnly");
node.status({ fill: "blue", shape: "dot", text: "TESTE: diagnóstico preservado em memória" });
return null;
