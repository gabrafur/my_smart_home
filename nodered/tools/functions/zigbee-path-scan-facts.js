const test=msg._zigbee_test===true,suffix=test?'__test':'',store=test?undefined:'persistent',memory=test?undefined:'memoryOnly';
let guard=test?msg.guard_test_facts:msg.payload;try{if(typeof guard==='string')guard=JSON.parse(guard)}catch{guard=null}
const p=flow.get('zigbee_path_policy_v1'+suffix,store),scan=flow.get('zigbee_path_scan'+suffix,store),now=Number(msg.monitor_now??Date.now());
const bridge=flow.get('zigbee_bridge_observation'+suffix,memory),boot=flow.get('zigbee_boot_at'+suffix,memory);
const policy=flow.get('zigbee_monitor_policy_v2','persistent');
const incidents=flow.get('zigbee_route_incidents_v1'+suffix,store)||{};
msg.zigbee_path_scan_ready=!!(guard?.schema_version===1&&guard.running===true&&guard.maintenance_active===false&&guard.operation_active===false&&guard.blocked_unknown===false&&guard.invalid_param_count===0&&Number.isFinite(guard.observed_at)&&now>=guard.observed_at&&now-guard.observed_at<=90000&&p&&policy&&bridge?.state==='online'&&Number.isFinite(boot)&&now-boot>=policy.startup_grace_s*1000&&now-bridge.changed_at>=policy.recovery_confirmation_s*1000&&
 !Object.values(incidents).some(c=>c.pending_transaction!=null)&&!scan?.pending);
msg.zigbee_path_scan_due=!!(p&&(msg.zigbee_path_force_scan===true||!scan||now-scan.at>=p.scan_interval_min*60000));msg.zigbee_path_now=now;return msg;
