msg.payload.actuator_available = msg._light_availability.attempting_unavailable !== true;
msg.payload.actuator_confirmation_pending =
    msg._light_availability.attempting_unavailable === true;
msg.payload.reflector_state_before_attempt = msg._light_availability.physical;
msg.payload.would_turn_on = true;
msg._light_availability.output = 0;
return msg;
