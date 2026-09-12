const value = msg._vehicle_in_use_value;
const reason = msg._vehicle_in_use_reason;
if (typeof value === "boolean") {
    msg._vehicle.in_use = value;
    msg._vehicle.in_use_reason = reason;
}
delete msg._vehicle_in_use_value;
delete msg._vehicle_in_use_reason;
return msg;
