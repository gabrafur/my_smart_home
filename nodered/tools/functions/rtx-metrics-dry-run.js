const result = { simulated: true, dispatched: false, topic: msg.topic, valid_json: false };
try { JSON.parse(msg.payload); result.valid_json = true; } catch (_) { /* Invalid output stays test-only. */ }
flow.set("rtx_metrics_test_result", result);
node.status({ fill: result.valid_json ? "green" : "red", shape: "dot", text: "TESTE: sem publicar MQTT" });
return null;
