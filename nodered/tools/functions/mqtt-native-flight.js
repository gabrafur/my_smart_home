const key = "mqtt_native_inflight_v1" + (msg.test_mode === true ? "__test" : "");
msg._mqtt_flight_key = key;
msg._mqtt_inflight = flow.get(key, "memoryOnly") !== undefined && flow.get(key, "memoryOnly") !== false;
return msg;
