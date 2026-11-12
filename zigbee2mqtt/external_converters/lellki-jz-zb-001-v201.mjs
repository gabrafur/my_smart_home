import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import * as reporting from "zigbee-herdsman-converters/lib/reporting";
import * as tuya from "zigbee-herdsman-converters/lib/tuya";
import * as utils from "zigbee-herdsman-converters/lib/utils";

const values = {off: 0, on: 1};
const outageMemory = {
    key: ["power_outage_memory"],
    convertSet: async (entity, key, value, meta) => {
        if (typeof value !== "string" || !Object.hasOwn(values, value)) {
            throw new Error("power_outage_memory must be off or on for firmware 2.0.1");
        }
        const options = utils.getOptions(meta.mapped, entity);
        const actual = await entity.read("genOnOff", ["startUpOnOff"], options);
        // The device reports this attribute as boolean and rejects writes with
        // READ_ONLY. An already-matching request can be confirmed without writing.
        if (actual.startUpOnOff !== values[value]) throw new Error("Startup behavior is read-only in firmware 2.0.1");
        return {state: {power_outage_memory: value}};
    },
    convertGet: async (entity, key, meta) => {
        await entity.read("genOnOff", ["startUpOnOff"], utils.getOptions(meta.mapped, entity));
    },
};

export default {
    fingerprint: [{modelID: "JZ-ZB-001", manufacturerName: "LELLKI", applicationVersion: 5, softwareBuildID: "2.0.1"}],
    model: "JZ-ZB-001",
    vendor: "LELLKI",
    description: "Smart plug with standard startup behavior (firmware 2.0.1)",
    extend: [tuya.modernExtend.tuyaBase(), tuya.modernExtend.tuyaOnOff({powerOnBehavior: false, powerOutageMemory: false})],
    exposes: [exposes.presets.enum("power_outage_memory", exposes.access.STATE_GET, ["off", "on"])
        .withCategory("diagnostic").withDescription("Power state after electricity returns (read-only in firmware 2.0.1)")],
    toZigbee: [outageMemory],
    fromZigbee: [{
        cluster: "genOnOff",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg) => {
            const value = Object.entries(values).find(([, raw]) => raw === msg.data.startUpOnOff)?.[0];
            return value === undefined ? undefined : {power_outage_memory: value};
        },
    }],
    configure: async (device, coordinatorEndpoint) => {
        const endpoint = device.getEndpoint(1);
        await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff"]);
        await endpoint.read("genOnOff", ["startUpOnOff"]);
    },
};
