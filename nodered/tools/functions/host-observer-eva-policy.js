const p=msg.payload;
const bounds={owner_escalation_ms:[3600000,604800000],audit_retention_days:[7,90],transport_confirm_ms:[30000,600000]};
if(!p||Object.keys(p).length!==4||!['shadow','exclusive'].includes(p.delivery_mode)||!Object.entries(bounds).every(([k,[lo,hi]])=>Number.isSafeInteger(p[k])&&p[k]>=lo&&p[k]<=hi)){
 node.status({fill:'red',shape:'ring',text:'política rejeitada; anterior preservada'});return null;
}
flow.set('eva_notice_policy_v1',{...p},'persistent');return null;
