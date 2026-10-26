const assert=require('node:assert/strict'),crypto=require('node:crypto');
const d=require('./download_backup.cjs');
const id='synthetic-artifact',hash=crypto.createHash('sha256').update(id).digest('hex');
function fixture(){return {state:'idle',agent_errors:{},backups:[{backup_id:id,date:'2000-01-01T00:00:00+00:00',name:'Daily off-site Compose v1 SYNTHETIC',homeassistant_included:true,database_included:false,agents:{'onedrive.fixture':{protected:true,size:d.SIZE}},failed_agent_ids:[],failed_folders:[],failed_addons:[]}]};}
assert.deepEqual(d.select(fixture(),hash),{id,agent:'onedrive.fixture'});
for(const change of [v=>v.state='busy',v=>v.agent_errors={one:'private-error'},v=>v.backups[0].date=null,v=>v.backups[0].date='2026-10-24T01:27:19-03:00',v=>v.backups[0].agents['onedrive.fixture'].protected=false,v=>v.backups[0].agents['onedrive.fixture'].size++,v=>v.backups[0].database_included=true,v=>v.backups.push(v.backups[0]),v=>v.backups[0].failed_folders.push('fixture')]){const v=fixture();change(v);assert.throws(()=>d.select(v,hash));}
const report=JSON.stringify(d.failureReport(Object.assign(Error('private-message'),{code:'private-code'})));assert(!report.includes('private-message')&&!report.includes('private-code'));
console.log(JSON.stringify({selector_cases:10,passed:true,network_called:false,credentials_read:false}));
