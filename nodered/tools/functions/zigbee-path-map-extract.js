if(!msg.zigbee_path_nodes)return msg;
const map=msg.zigbee_path_map,nodes=new Map(msg.zigbee_path_nodes.map(n=>[n.ieeeAddr.toLowerCase(),n])),co=msg.zigbee_path_coordinator;
function toward(start,end){
 const destination=nodes.get(end),path=[start];let current=start;
 while(current!==end&&path.length<=16){
  if(nodes.get(current)?.failed?.length)break;
  const hops=map.links.filter(l=>l&&String(l.target?.ieeeAddr).toLowerCase()===current&&Number(l.lqi??l.linkquality)>0&&Array.isArray(l.routes)&&
   l.routes.some(r=>r&&r.status==='ACTIVE'&&r.destinationAddress===destination.networkAddress&&r.nextHopAddress===l.source?.networkAddress));
  const next=[...new Set(hops.map(l=>String(l.source?.ieeeAddr).toLowerCase()))];
  if(next.length!==1||path.includes(next[0])||!nodes.has(next[0]))break;
  current=next[0];path.push(current);
 }
 return current===end?path:null;
}
const updates={};
for(const [ieee,node] of nodes){
 if(ieee===co||node.failed?.length)continue;
 let path=toward(co,ieee),direction='from_coordinator';
 if(!path){const reverse=toward(ieee,co);path=reverse?.reverse();direction='toward_coordinator';}
 if(path&&path.slice(1,-1).every(id=>nodes.get(id)?.type==='Router'))updates[ieee]={coordinator:co,ieee,path,observed_at:Number(msg.monitor_now??Date.now()),kind:'active_routing_table',direction};
}
msg.zigbee_path_updates=updates;return msg;
