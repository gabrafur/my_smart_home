#!/usr/bin/env node
// Fixed host adapter for the recovery decisions made on the Node-RED canvas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
function yamlModule() {
  try {return require('js-yaml');} catch {
    return createRequire(new URL('../nodered/package.json',import.meta.url))('js-yaml');
  }
}
const sha = v => crypto.createHash('sha256').update(v).digest('hex');

export function validateNetwork(config, backup, database) {
  const a = config?.advanced;
  if (!a || !backup || backup.metadata?.format !== 'zigpy/open-coordinator-backup' || backup.metadata.version !== 1 || !Array.isArray(backup.devices)) throw Error('invalid_backup');
  const rows = database.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const coordinators = rows.filter(d => d.type === 'Coordinator');
  const devices = rows.filter(d => d.type !== 'Coordinator');
  if (coordinators.length !== 1 || !devices.length || new Set(rows.map(d => d.ieeeAddr)).size !== rows.length) throw Error('invalid_database');
  if(devices.some(d=>d.interviewCompleted!==true))throw Error('interview_incomplete');
  const bytes = (v, length) => Array.isArray(v) && v.length === length && v.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!bytes(a.network_key, 16) || !bytes(a.ext_pan_id, 8) || !Number.isInteger(a.channel) || a.channel < 11 || a.channel > 26 ||
      backup.coordinator_ieee !== coordinators[0].ieeeAddr.replace(/^0x/, '') ||
      Number.parseInt(backup.pan_id, 16) !== a.pan_id || backup.extended_pan_id !== Buffer.from(a.ext_pan_id).toString('hex') ||
      backup.network_key?.key !== Buffer.from(a.network_key).toString('hex') || backup.channel !== a.channel ||
      !Number.isSafeInteger(backup.network_key.frame_counter) || backup.network_key.frame_counter < 0 ||
      !devices.every(d => backup.devices.some(b => b.ieee_address === d.ieeeAddr.replace(/^0x/, '')))) throw Error('network_identity_mismatch');
  // Z-Stack can retain its old primary-channel mask after a channel migration.
  // Only align it when the recorded operating channel already equals config.
  const normalized = structuredClone(backup);
  normalized.channel_mask = [a.channel];
  const identity = sha(JSON.stringify([a.pan_id, a.ext_pan_id, a.network_key, a.channel, backup.coordinator_ieee]));
  return {backup: normalized, devices: devices.length, identity,
    last_seen: Math.max(0, ...devices.map(d => Number(d.lastSeen) || 0)),
    normalized_channel_mask: JSON.stringify(backup.channel_mask) !== JSON.stringify(normalized.channel_mask)};
}

export function snapshotEligible(candidate, baseline, facts) {
  return facts.running === true && facts.uptime_s >= 300 && facts.invalid_param_count === 0 &&
    Number.isFinite(facts.last_seen_age_s) && facts.last_seen_age_s <= 300 && (!baseline || candidate.identity === baseline.identity && candidate.devices >= baseline.devices);
}

export function requestValid(r, facts, now, journal) {
  return r && Object.keys(r).sort().join(',') === 'action,facts_id,id,requested_at' &&
    /^[a-f0-9]{32}$/.test(r.id) && ['snapshot','restart','restore'].includes(r.action) &&
    r.facts_id === facts.id && Number.isFinite(r.requested_at) && now >= r.requested_at && now-r.requested_at <= 90000 &&
    !journal.receipts?.some(x => x.id === r.id);
}

function atomic(file, data, mode = 0o600) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'wx', mode);
  try {fs.fchmodSync(fd,mode);fs.writeFileSync(fd, data); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(temp, file);
}
function read(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4*1024*1024) throw Error('unsafe_file');
  return fs.readFileSync(file, 'utf8');
}
function optional(file, fallback) {try {return JSON.parse(read(file));} catch(e) {if(e.code === 'ENOENT')return fallback;throw e;}}
function docker(args) {
  const r=spawnSync('/usr/bin/docker',args,{encoding:'utf8',timeout:args[0]==='run'?180000:45000,maxBuffer:4*1024*1024});
  if(r.error || r.status !== 0)throw Error('docker_operation_failed');
  return r.stdout;
}
export const adapterRestoreScript = String.raw`
const fs=require('fs'),yaml=require('js-yaml'),{Adapter}=require('zigbee-herdsman/dist/adapter/adapter');
const version=require('zigbee-herdsman/package.json').version;
async function restore(){
 if(version!=='11.2.0')throw Error('unreviewed_adapter_version');
 const c=yaml.load(fs.readFileSync('/app/data/configuration.yaml','utf8')),a=c.advanced;
 if(c.serial.adapter!=='zstack'||!String(c.serial.port).startsWith('tcp://'))throw Error('unsupported_adapter');
 const adapter=await Adapter.create({panID:a.pan_id,extendedPanID:a.ext_pan_id,channelList:[a.channel],networkKey:a.network_key,networkKeyDistribute:false},{path:c.serial.port,baudRate:c.serial.baudrate||115200,adapter:'zstack'},'/app/data/coordinator_backup.json',{disableLED:!c.serial.disable_led,transmitPower:a.transmit_power});
 try {
  const result=await adapter.start();
  if(result==='resumed'){
   if(typeof adapter.adapterManager?.beginRestore!=='function')throw Error('restore_capability_missing');
   await adapter.adapterManager.beginRestore();
  }else if(result!=='restored')throw Error('unexpected_adapter_start');
 }finally{await adapter.stop();}
}
restore().catch(()=>{process.exitCode=1});
`;
const backupRpc = String.raw`
const fs=require('fs'),yaml=require('js-yaml'),mqtt=require('mqtt'),crypto=require('crypto');
const c=yaml.load(fs.readFileSync('/app/data/configuration.yaml','utf8'));
const tx=crypto.randomBytes(16).toString('hex'),base=c.mqtt.base_topic||'zigbee2mqtt';
const m=mqtt.connect(c.mqtt.server,{username:c.mqtt.user,password:c.mqtt.password,reconnectPeriod:0,connectTimeout:4000});
const end=ok=>{clearTimeout(timer);process.exitCode=ok?0:1;m.end(true)};
const timer=setTimeout(()=>end(false),35000);
m.on('error',()=>end(false));
m.on('connect',()=>m.subscribe(base+'/bridge/response/backup',{qos:1},e=>{
 if(e)return end(false);m.publish(base+'/bridge/request/backup',JSON.stringify({transaction:tx}),{qos:1,retain:false});
}));
m.on('message',(t,b,p)=>{if(p.retain)return;try{const r=JSON.parse(b);if(r.transaction===tx)end(r.status==='ok')}catch{end(false)}});
`;

export function tick(root = '/mnt/data/docker', privateDir = '/var/lib/zigbee-coordinator-recovery', runtime = {}) {
  const runDocker=runtime.docker||docker;
  const publicDir=path.join(root,'nodered','zigbee-recovery');
  const dataDir=path.join(root,'zigbee2mqtt');
  fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
  fs.mkdirSync(publicDir,{recursive:true,mode:0o755});
  const journalFile=path.join(privateDir,'journal.json');
  const journal=optional(journalFile,{receipts:[],last_recovery_at:0,recoveries:[]});
  const baselineFile=path.join(privateDir,'last-good.json');
  let baseline=optional(baselineFile,null);
  const yaml=yamlModule();
  const config=yaml.load(read(path.join(dataDir,'configuration.yaml')));
  const now=runtime.now?.()??Date.now();
  const state=JSON.parse(runDocker(['inspect','zigbee2mqtt','--format','{{json .State}}']));
  let candidate=null;
  try {candidate=validateNetwork(config,JSON.parse(read(path.join(dataDir,'coordinator_backup.json'))),read(path.join(dataDir,'database.db')));} catch {}
  const database=read(path.join(dataDir,'database.db')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  // Docker writes container stderr to stderr too; collect both streams privately.
  const logResult=runtime.logs?.()||spawnSync('/usr/bin/docker',['logs','--since','5m','--tail','500','zigbee2mqtt'],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
  const logsAvailable=!logResult.error&&logResult.status===0;
  const logs=(logResult.stdout||'')+(logResult.stderr||'');
  const lastSeen=Math.max(0,...database.map(d=>Number(d.lastSeen)||0));
  const facts={schema_version:1,id:crypto.randomBytes(16).toString('hex'),observed_at:now,
    running:state.Running===true,uptime_s:Math.max(0,(now-Date.parse(state.StartedAt))/1000),
    device_count:database.filter(d=>d.type!=='Coordinator').length,
    backup_valid:!!candidate,last_good_available:!!baseline,last_good_count:baseline?.devices||0,
    invalid_param_count:logsAvailable?(logs.match(/\(0x02: INVALID_PARAM\)/g)||[]).length:null,
    log_observation_reason:logsAvailable?'ok':String(logResult.error?.code||logResult.signal||`exit_${logResult.status}`).replace(/[^a-zA-Z0-9_]/g,'').slice(0,40),
    last_seen_age_s:lastSeen&&lastSeen<=now?(now-lastSeen)/1000:null,
    last_snapshot_at:baseline?.saved_at||0,last_recovery_at:journal.last_recovery_at,
    recoveries_24h:journal.recoveries.filter(t=>now-t<86400000).length,
    operation_active:false,blocked_unknown:!logsAvailable||journal.receipts.some(r=>r.status==='running')};
  facts.maintenance_active=['.daily-maintenance.lock','.offsite-backup.lock'].some(name=>{
    const file=path.join(root,name);if(!fs.existsSync(file))return false;
    return spawnSync('/usr/bin/flock',['-n',file,'/usr/bin/true'],{timeout:1000}).status!==0;
  })||fs.existsSync(path.join(root,'.docker-auto-update.lock'))||fs.existsSync(path.join(privateDir,'firmware-active.json'));
  const previous=optional(path.join(publicDir,'facts.json'),null);
  const requestFile=path.join(publicDir,'request.json');
  const request=optional(requestFile,null);
  const issued=(journal.observations||[]).find(f=>f.id===request?.facts_id)||previous;
  if(request && issued && requestValid(request,issued,now,journal)) {
    const receipt={id:request.id,action:request.action,status:'running',at:now};
    journal.receipts.push(receipt);
    journal.receipts=journal.receipts.filter((r,i,a)=>r.status==='running'||i>=a.length-64);
    atomic(journalFile,JSON.stringify(journal)); // Intent precedes any effect; interruption blocks replay.
    atomic(path.join(publicDir,'facts.json'),JSON.stringify({...facts,receipt,blocked_unknown:true,operation_active:true})+'\n',0o644);
    try {
      if(facts.maintenance_active)throw Error('maintenance_active');
      if(facts.blocked_unknown)throw Error('operation_unresolved');
      if(request.action==='snapshot') {
        if(!snapshotEligible({identity:baseline?.identity,devices:facts.device_count},baseline,facts))throw Error('snapshot_not_healthy');
        runDocker(['exec','zigbee2mqtt','node','-e',backupRpc]);
        candidate=validateNetwork(config,JSON.parse(read(path.join(dataDir,'coordinator_backup.json'))),read(path.join(dataDir,'database.db')));
        if(!snapshotEligible(candidate,baseline,facts))throw Error('snapshot_not_healthy');
        const bundle={version:1,saved_at:now,identity:candidate.identity,devices:candidate.devices,
          configuration:read(path.join(dataDir,'configuration.yaml')),
          database:read(path.join(dataDir,'database.db')),
          backup:JSON.stringify(candidate.backup,null,2)+'\n'};
        bundle.digest=sha(JSON.stringify(bundle));
        atomic(path.join(privateDir,`snapshot-${now}.json`),JSON.stringify(bundle));
        atomic(baselineFile,JSON.stringify(bundle));baseline=bundle;
        const old=fs.readdirSync(privateDir).filter(n=>/^snapshot-\d+\.json$/.test(n)).sort();
        for(const name of old.slice(0,-32))fs.unlinkSync(path.join(privateDir,name));
        receipt.status='snapshotted';
      } else {
        if(!baseline || facts.blocked_unknown || now-journal.last_recovery_at<900000 || facts.recoveries_24h>=2 ||
           (facts.running && facts.uptime_s<300))throw Error('recovery_gate_refused');
        const {digest,...bundle}=baseline;
        if(sha(JSON.stringify(bundle))!==digest)throw Error('snapshot_integrity_failed');
        const restored=validateNetwork(config,JSON.parse(baseline.backup),baseline.database);
        if(restored.identity!==baseline.identity)throw Error('network_changed');
        if(request.action==='restart' && facts.running && facts.invalid_param_count<3)throw Error('restart_without_failure');
        if(request.action==='restore' && facts.device_count>0)throw Error('restore_without_loss');
        journal.last_recovery_at=now;journal.recoveries=journal.recoveries.filter(t=>now-t<86400000);journal.recoveries.push(now);
        atomic(journalFile,JSON.stringify(journal));
        // Preserve failed data before stop, since a clean stop can rewrite it.
        const evidence={database:read(path.join(dataDir,'database.db')),backup:read(path.join(dataDir,'coordinator_backup.json'))};
        atomic(path.join(privateDir,`before-${request.id}.json`),JSON.stringify(evidence));
        runDocker(['stop','-t','20','zigbee2mqtt']);
        try {
          if(request.action==='restore')atomic(path.join(dataDir,'database.db'),baseline.database,0o644);
          const b=request.action==='restore'?restored.backup:validateNetwork(config,JSON.parse(evidence.backup),evidence.database).backup;
          atomic(path.join(dataDir,'coordinator_backup.json'),JSON.stringify(b,null,2)+'\n',0o644);
          if(request.action==='restore') {
            const image=runDocker(['inspect','zigbee2mqtt','--format','{{.Image}}']).trim();
            if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('invalid_image_identity');
            runDocker(['run','--rm','--name','zigbee-coordinator-restore','--network','host','--memory','192m','--memory-swap','192m','--cpus','0.5','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=16m','--volume',`${dataDir}:/app/data:rw`,'--entrypoint','node',image,'-e',adapterRestoreScript]);
          }
        } finally {
          const temporary=runDocker(['ps','--filter','name=^/zigbee-coordinator-restore$','--format','{{.Names}}']);
          if(temporary.trim())throw Error('radio_restore_still_running');
          runDocker(['start','zigbee2mqtt']);
        }
        receipt.status='dispatched'; // Online and physical recovery must be observed later.
        const observed=JSON.parse(runDocker(['inspect','zigbee2mqtt','--format','{{json .State}}']));
        facts.running=observed.Running===true;facts.uptime_s=Math.max(0,(Date.now()-Date.parse(observed.StartedAt))/1000);
        facts.device_count=read(path.join(dataDir,'database.db')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(d=>d.type!=='Coordinator').length;
      }
    } catch(e) {receipt.status='failed';receipt.reason=/^[a-z_]+$/.test(e.message)?e.message:'operation_failed';}
    atomic(journalFile,JSON.stringify(journal));
  }
  const result={...facts,last_snapshot_at:baseline?.saved_at||0,last_good_available:!!baseline,
    last_good_count:baseline?.devices||0,last_recovery_at:journal.last_recovery_at,
    receipt:journal.receipts.at(-1)||null,
    firmware_inventory:optional(path.join(publicDir,'firmware-inventory.json'),null)};
  journal.observations=[...(journal.observations||[]),{id:facts.id,observed_at:now}].slice(-8);
  atomic(journalFile,JSON.stringify(journal));
  atomic(path.join(publicDir,'facts.json'),JSON.stringify(result)+'\n',0o644);
  return result;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  try {tick();} catch {console.error('ZIGBEE_GUARD observation_failed');process.exitCode=1;}
}
