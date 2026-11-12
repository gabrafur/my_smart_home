const p=msg.payload,test=msg._zigbee_test===true;
msg.zigbee_path_policy_valid=!!p&&Number.isInteger(p.facts_max_age_s)&&p.facts_max_age_s>=30&&p.facts_max_age_s<=300&&Number.isInteger(p.max_age_min)&&p.max_age_min>=60&&p.max_age_min<=10080&&Number.isInteger(p.scan_interval_min)&&p.scan_interval_min>=30&&p.scan_interval_min<=1440&&Number.isInteger(p.max_hops)&&p.max_hops>=1&&p.max_hops<=8&&typeof p.upstream_configure==='boolean'&&typeof p.offline_recovery==='boolean';
if(msg.zigbee_path_policy_valid)flow.set('zigbee_path_policy_v1'+(test?'__test':''),{...p},test?undefined:'persistent');
return msg;
