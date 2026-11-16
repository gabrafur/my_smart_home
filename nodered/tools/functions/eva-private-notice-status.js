const roles=['native_systemd_procmon','native_systemd_mcp_collection','native_systemd_external_heartbeat','native_docker_ai-bridge','observation_host_report','delivery_test'];
const read=(name,uid)=>{let fd;try{fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==uid||(s.mode&0o027)||s.size>1048576)throw Error('eva_status_identity');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}};
const now=Date.now();let pending=null,deliveryAck=null;
for(const role of roles){
 const q=read('/data/.eva-notice-outbox/'+role+'.json',1000);if(!q)continue;
 const r=read('/data/.eva-notice-receipts/'+role+'.json',1001),last=q.events?.at(-1);
 if(!last)continue;
 if(role==='delivery_test'&&r?.revision===last.revision&&r?.sequence===last.sequence){const content=last.content===null?null:JSON.parse(last.content);deliveryAck={_eva_private_test_ack:{operation:content===null?'dismiss':'create',created_at:content?.created_at??null,revision:r.revision,previous_revision:last.previous_revision}};}
 const validPolicy=Number.isSafeInteger(q.policy?.transport_confirm_ms)&&q.policy.transport_confirm_ms>=30000&&q.policy.transport_confirm_ms<=600000;
 if(!validPolicy)throw Error('eva_status_policy');
 if(r?.revision!==last.revision||r?.sequence!==last.sequence){
  const earliest=q.events.find(e=>!r||e.sequence>r.sequence);
  const at=Date.parse(earliest?.enqueued_at);if(!Number.isFinite(at)||at>now)throw Error('eva_status_clock');
  const row={age:now-at,threshold:q.policy.transport_confirm_ms};
  if(!pending||row.age-row.threshold>pending.age-pending.threshold)pending=row;
 }
}
const health=read('/data/.eva-notice-receipts/transport-health.json',1001);
if(health && health.state!=='observed')throw Error('eva_consumer_reported_failure');
msg._eva_transport_ok=pending===null;
msg._eva_transport_age_ms=pending?.age??0;
msg._eva_transport_confirm_ms=pending?.threshold??null;
return [msg,deliveryAck];
