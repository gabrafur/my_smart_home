const key = msg.confirmation?.is_test ? "alarm_arrival_test_pending_confirmation" : "alarm_arrival_pending_confirmation";
flow.set(key, null);
return null;
