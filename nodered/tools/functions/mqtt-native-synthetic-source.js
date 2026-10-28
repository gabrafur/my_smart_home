if (msg.test_mode !== true || msg._mqtt_test_source !== true) return null;
msg.payload = msg._mqtt_synthetic_cli;
return msg;
