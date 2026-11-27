// Protocol-only adapter. Routing decisions are supplied by the canonical canvas.
const roles = new Set(['native_systemd_procmon','native_systemd_mcp_collection','native_systemd_external_heartbeat','native_docker_ai-bridge','observation_host_report','delivery_test']);
const p = msg.payload ?? {};
const deliveryTest=msg._eva_private_delivery_test===true&&p.incident_key==='delivery_test'&&p.notification_delivery_under_test===true;
if (p.incident_key==='delivery_test'&&!deliveryTest)throw Error('eva_delivery_test_contract');
if ((msg._global_observer_test === true || p.test_mode === true)&&!deliveryTest) {
    msg._eva_private_result = {simulated:true,dispatched:false};
    return msg;
}
if (p.notification_audience !== 'eva_private' ||
    !['create','dismiss'].includes(p.persistent_notification_operation)) throw Error('eva_export_contract');
// The audience gate admits every native/resource/observation key; the root spool has
// only these files. Another host incident (AppDaemon stopped by the offsite backup,
// 27/11/2026) used to throw here and page the owner. It stays in host_observation and
// in the registry, whose 24 h escalation still reaches the owner.
if (!roles.has(p.incident_key)) {
    node.status({fill:'grey',shape:'ring',text:'fora do espelho da Eva: '+String(p.incident_key).slice(0,60)});
    msg._eva_private_result = {dispatched:false,state:'not_mirrored'};
    return msg;
}
const dir='/data/.eva-notice-outbox';
const receiptDir='/data/.eva-notice-receipts';
const role=p.incident_key;
const id='eva_private_'+role.replaceAll('-','_');
const hash = body => crypto.createHash('sha256').update(body).digest('hex');
const checkDir=(name,uid,gid)=>{
    const s=fs.lstatSync(name);
    if(!s.isDirectory()||s.uid!==uid||s.gid!==gid||(s.mode&0o022))throw Error('eva_directory_identity');
};
const read=(name,uid,gid)=>{
    let fd;
    try{fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT')return null;throw e;}
    try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==uid||s.gid!==gid||(s.mode&0o027)||s.size>1048576)throw Error('eva_file_identity');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
};
checkDir(dir,1000,1001);checkDir(receiptDir,1001,1000);
const target=dir+'/'+role+'.json';
const before=read(target,1000,1001);
let queue=before===null?{schema_version:1,role,events:[]}:JSON.parse(before);
if(queue.schema_version!==1||queue.role!==role||!Array.isArray(queue.events)||queue.events.length>64)throw Error('eva_queue_shape');
const receiptBody=read(receiptDir+'/'+role+'.json',1001,1000);
const receipt=receiptBody===null?null:JSON.parse(receiptBody);
if(receipt && (receipt.schema_version!==1||receipt.role!==role||!Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||! /^[a-f0-9]{64}$/.test(receipt.revision)))throw Error('eva_receipt_shape');
const last=queue.events.at(-1);
const operation=p.persistent_notification_operation;
const notice=operation==='dismiss'?null:{schema_version:1,notification_id:id,title:String(msg.alert?.title??'').slice(0,200),message:String(msg.alert?.message??'').slice(0,6000),created_at:p.policy_decided_at};
if(deliveryTest&&notice&&(!notice.title.startsWith('TESTE')||!notice.message.startsWith('TESTE')))throw Error('eva_delivery_test_label');
if(notice&&(!notice.title||!notice.message||!Number.isFinite(Date.parse(notice.created_at))))throw Error('eva_notice_shape');
const content=notice===null?null:JSON.stringify(notice);
if(last?.content===content){msg._eva_private_result={dispatched:false,state:'duplicate',revision:last.revision};return msg;}
if(receipt){
    const matched=queue.events.find(e=>e.sequence===receipt.sequence&&e.revision===receipt.revision);
    if(!matched)throw Error('eva_receipt_unmatched');
    queue.events=queue.events.filter(e=>e.sequence>=receipt.sequence);
}
if(queue.events.length>=64)throw Error('eva_queue_full');
const policy=msg._eva_policy;
if(!policy||!Number.isSafeInteger(policy.audit_retention_days)||policy.audit_retention_days<7||policy.audit_retention_days>90||!Number.isSafeInteger(policy.transport_confirm_ms)||policy.transport_confirm_ms<30000||policy.transport_confirm_ms>600000)throw Error('eva_export_policy');
queue.policy={audit_retain_after:new Date(Date.now()-policy.audit_retention_days*86400000).toISOString(),transport_confirm_ms:policy.transport_confirm_ms};
queue.updated_at=new Date().toISOString();
const event={enqueued_at:new Date().toISOString(),sequence:(last?.sequence??0)+1,previous_revision:last?.revision??null,content};
event.revision=hash(JSON.stringify([role,event.sequence,event.previous_revision,event.content,event.enqueued_at]));
queue.events.push(event);
const after=JSON.stringify(queue)+'\n';
if(Buffer.byteLength(after)>1048576)throw Error('eva_queue_bytes');
if(read(target,1000,1001)!==before)throw Error('eva_export_cas');
const temp=dir+'/.pending-'+crypto.randomBytes(12).toString('hex');
let fd;
try{
    fd=fs.openSync(temp,'wx',0o640);fs.fchownSync(fd,1000,1001);fs.fchmodSync(fd,0o640);fs.writeFileSync(fd,after);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(temp,target);const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
msg._eva_private_result={dispatched:true,state:'queued_not_delivered',revision:event.revision,sequence:event.sequence};
return msg;
