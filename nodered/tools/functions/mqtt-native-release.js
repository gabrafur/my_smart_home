if (msg._mqtt_owns_flight === true && typeof msg._mqtt_flight_token === "string"
    && flow.get(msg._mqtt_flight_key,"memoryOnly")?.token === msg._mqtt_flight_token)
    flow.set(msg._mqtt_flight_key,false,"memoryOnly");
return msg;
