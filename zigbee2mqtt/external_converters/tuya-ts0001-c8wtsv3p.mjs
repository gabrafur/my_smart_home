import * as reporting from "zigbee-herdsman-converters/lib/reporting";
import * as tuya from "zigbee-herdsman-converters/lib/tuya";

export default {
    fingerprint: tuya.fingerprint("TS0001", ["_TZ3000_c8wtsv3p"]),
    model: "TS0001_c8wtsv3p",
    vendor: "Tuya",
    description: "1 gang switch that reports state without a ZCL default response",
    extend: [
        tuya.modernExtend.tuyaBase(),
        tuya.modernExtend.tuyaOnOff({
            powerOnBehavior2: false,
            switchType: false,
            backlightModeOffOn: false,
        }),
    ],
    meta: {disableDefaultResponse: true},
    configure: async (device, coordinatorEndpoint) => {
        await tuya.configureMagicPacket(device, coordinatorEndpoint);
        await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ["genOnOff"]);
    },
};
