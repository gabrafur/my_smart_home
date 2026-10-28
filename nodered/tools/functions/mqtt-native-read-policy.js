const test = msg.test_mode === true;
msg._mqtt_store = test ? "memoryOnly" : "persistent";
msg._mqtt_key = "mqtt_native_observer_v1" + (test ? "__test" : "");
msg._mqtt_policy = flow.get("mqtt_native_policy_v1" + (test ? "__test" : ""), msg._mqtt_store);
msg._mqtt_enabled = msg._mqtt_policy?.enabled === true;
msg._mqtt_window_request_key="mqtt_native_window_request_v1"+(test?"__test":"");
msg._mqtt_window_request_id=flow.get(msg._mqtt_window_request_key,msg._mqtt_store)?.id_sha256??null;
return msg;
