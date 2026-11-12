if(!msg.zigbee_path_updates||!msg.zigbee_path_nodes)return msg;
const nodes=new Map(msg.zigbee_path_nodes.map(n=>[n.ieeeAddr.toLowerCase(),n])),updates=msg.zigbee_path_updates,co=msg.zigbee_path_coordinator;
for(const [ieee,n] of nodes){
 if(n.type!=='EndDevice'||n.failed?.length||updates[ieee])continue;
 // CHILD in a router's neighbor table identifies a parent relation, unlike
 // a generic neighbor or an LQI-based guess. Require one unambiguous parent.
 const parents=[...new Set(msg.zigbee_path_map.links.filter(l=>l&&String(l.source?.ieeeAddr).toLowerCase()===ieee&&l.relationship===1&&Number(l.lqi??l.linkquality)>0).map(l=>String(l.target?.ieeeAddr).toLowerCase()))];
 if(parents.length!==1)continue;
 const parent=parents[0];if(!['Router','Coordinator'].includes(nodes.get(parent)?.type))continue;
 const upstream=parent===co?[co]:updates[parent]?.path;
 if(!upstream||upstream.includes(ieee)||upstream.length>=16)continue;
 updates[ieee]={coordinator:co,ieee,path:[...upstream,ieee],observed_at:Number(msg.monitor_now??Date.now()),kind:parent===co?'neighbor_parent':'parent_and_active_routing_table',direction:'toward_coordinator'};
}
return msg;
