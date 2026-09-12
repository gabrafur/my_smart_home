const value = msg.vpn;
value.states.vpn_primary = value.current;
if (value.store) flow.set(`vpn_monitor_state_v1${value.suffix}`, value.states, value.store);
else flow.set(`vpn_monitor_state_v1${value.suffix}`, value.states);
return msg;
