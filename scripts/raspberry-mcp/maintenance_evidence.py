"""Bounded, read-only evidence. Payloads are projected, never regex-redacted verbatim."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time
import maintenance_diagnostics as d

ROOT=Path('/mnt/data/docker')
STAGES=('offsite-backup','dietpi','home-assistant-core','containers','codex-cli')
REASONS={'none','maintenance_busy','validation_busy','unknown_failure','remote_diverged',
 'network_unavailable','authentication_or_access','validation_node_red_layout','validation_failed',
 'remote_operation_failed','security_scan_failed','completed','daily-offsite-backup-not-active'}
STATUS={'success','failed','deferred','running'}

def timestamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)',value):return None
    try:return dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except ValueError:return None

def cause(error):
    if isinstance(error,FileNotFoundError):return 'source_missing'
    if isinstance(error,PermissionError):return 'source_permission_denied'
    if isinstance(error,subprocess.TimeoutExpired):return 'collection_timeout'
    return 'source_invalid_or_unavailable'

def bounded_command(argv, limit=262144, timeout=6):
    process=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=d.ENV)
    selector=selectors.DefaultSelector();chunks=[];size=0;end=time.monotonic()+timeout
    try:
        for stream in (process.stdout,process.stderr):
            os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ)
        while selector.get_map():
            if time.monotonic()>end:raise subprocess.TimeoutExpired('fixed_collector',timeout)
            for key,_ in selector.select(min(.1,max(0,end-time.monotonic()))):
                data=os.read(key.fd,8192)
                if not data:selector.unregister(key.fileobj);continue
                size+=len(data)
                if size>limit:raise ValueError('collection_size_limit')
                chunks.append(data)
        if process.wait(timeout=1)!=0:raise ValueError('collector_failed')
        return b''.join(chunks).decode('utf8',errors='replace')
    finally:
        selector.close()
        if process.poll() is None:process.kill()
        process.wait()
        process.stdout.close();process.stderr.close()

def fixed_tail(path,limit=131072):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):raise ValueError('unsupported_source')
        start=max(0,info.st_size-limit);os.lseek(fd,start,os.SEEK_SET)
        text=os.read(fd,limit).decode('utf8',errors='replace')
        return text.split('\n',1)[-1] if start else text
    finally:os.close(fd)

def result_file(path, source, now=None):
    now=time.time() if now is None else now
    try:
        raw=d.read_fixed(path,8192)
        fields=dict(re.findall(r'\b([a-z_]+)=([^\s]+)',raw))
        status=fields.get('status') if fields.get('status') in STATUS else 'unknown'
        finished=timestamp(fields.get('finished_at'));started=timestamp(fields.get('started_at'))
        observed=finished or started
        row={'status':status,'reason':fields.get('reason') if fields.get('reason') in REASONS else 'not_reported_or_not_allowlisted',
             'finished_at':d.utc(finished) if finished else None,'started_at':d.utc(started) if started else None,
             'exit_code':int(fields['exit_code']) if re.fullmatch(r'\d{1,3}',fields.get('exit_code','')) else None,
             'operation_id':hashlib.sha256(fields['request_id'].encode()).hexdigest()[:32] if fields.get('request_id') else None}
        for key in ('capture_verified','remote_verified','protected'):
            row[key]=fields.get(key)=='true' if fields.get(key) in ('true','false') else None
        row['components']=int(fields['components']) if re.fullmatch(r'\d{1,4}',fields.get('components','')) else None
        return d.evidence(source,row, 'failed' if status=='failed' else 'unknown',
                          error=None if observed else 'producer_timestamp_missing',observed=observed or now,now=now,
                          coverage=['latest_producer_result_only','success_not_proof_of_restoration'],ttl=3600)
    except (OSError,ValueError,UnicodeError) as error:
        return d.evidence(source,{'status':'unknown','reason':cause(error)},error=cause(error),now=now,
                          coverage=['latest_producer_result_unavailable'])

def queue(path,source,now=None):
    now=time.time() if now is None else now
    try:
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode):raise ValueError('unsupported_source')
        raw=d.read_fixed(path,256).strip()
        # Never expose request contents. mtime is not a claimed creation time.
        row={'present':True,'mtime':d.utc(info.st_mtime),'age_seconds':max(0,now-info.st_mtime),
             'operation_id':hashlib.sha256(raw.encode()).hexdigest()[:32]}
        return d.evidence(source,row,coverage=['file_metadata','mtime_not_creation'],now=now)
    except FileNotFoundError:
        return d.evidence(source,{'present':False},coverage=['file_metadata'],now=now)
    except (OSError,ValueError,UnicodeError) as error:
        return d.evidence(source,None,error=cause(error),coverage=['file_metadata'],now=now)

def lock_counts(active,info):
    holders=waiters=0
    for line in active.splitlines():
        match=re.search(r'\b([0-9a-f]+):([0-9a-f]+):(\d+)\b',line)
        if not match:continue
        if tuple(int(v,16 if i<2 else 10) for i,v in enumerate(match.groups()))!=(os.major(info.st_dev),os.minor(info.st_dev),info.st_ino):continue
        if '->' in line.split():waiters+=1
        else:holders+=1
    return holders,waiters

def locks(root=ROOT):
    rows=[]
    try:active=d.read_fixed('/proc/locks',131072)
    except (OSError,ValueError):active=None
    for name,path in [('maintenance',root/'.daily-maintenance.lock'),('git_backup',root/'.git-backup.lock'),
                       ('public_validation',Path('/tmp/my-smart-home-public-validation.lock'))]:
        try:
            info=path.lstat()
            if not stat.S_ISREG(info.st_mode):raise ValueError('unsupported_source')
            holders,waiters=lock_counts(active,info) if active is not None else (None,None)
            rows.append(d.evidence('proc.locks.'+name,{'lock':name,'held':holders>0 if holders is not None else None,
                          'holder_count':holders,'waiter_count':waiters},
                          error=None if active is not None else 'lock_table_unavailable',coverage=['instantaneous','owner_not_exposed','waiters_are_not_holders','private_tmp_may_hide_host_validation_lock','free_now_does_not_disprove_prior_contention']))
        except (OSError,ValueError) as error:
            rows.append(d.evidence('proc.locks.'+name,{'lock':name,'held':None},error=cause(error),coverage=['instantaneous','absence_does_not_prove_unlocked']))
    return rows

def git_last_success(root=ROOT):
    try:
        text=fixed_tail(root/'.git-backup.log')
        matches=re.findall(r'^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d))\] backup finished: (no changes|pushed [a-f0-9]{7,40})$',text,re.M)
        if matches:
            when=dt.datetime.fromisoformat(matches[-1][0].replace('Z','+00:00')).timestamp()
            return d.evidence('git_backup.bounded_log',{'finished_at':d.utc(when),'kind':'no_changes' if matches[-1][1]=='no changes' else 'pushed'},observed=when,coverage=['last_success_in_bounded_log','not_restore_evidence'],ttl=86400)
        return d.evidence('git_backup.bounded_log',None,coverage=['no_success_in_last_128KiB','older_history_not_searched'])
    except (OSError,ValueError) as error:return d.evidence('git_backup.bounded_log',None,error=cause(error),coverage=['bounded_log_unavailable'])

def backups(root=ROOT):
    gitdir=root/'homeassistant/.git-backup-trigger';update=root/'homeassistant/.daily-update-trigger'
    git=result_file(gitdir/'result','git_backup.result');offsite=result_file(update/'offsite-backup-result','offsite.stage_result')
    gitdata=dict(git['data']);offdata=dict(offsite['data'])
    gitdata.update(evidence=git,requested=queue(gitdir/'requested','git_backup.requested'),processing=queue(gitdir/'processing','git_backup.processing'),
      locks=locks(root),last_success=git_last_success(root),next_retry={'at':None,'reason':'worker_documented_minutely_schedule_not_verified'})
    offdata.update(evidence=offsite,previous_unknown_origin='legacy_collector_hardcoded_unknown_and_never_read_offsite_result',
      requested=queue(update/'offsite-backup-requested','offsite.requested'),processing=queue(update/'offsite-backup-processing','offsite.processing'),
      last_success={'observed_at':None,'reason':'no_durable_success_history_in_allowed_result_source'},
      integrity={'verified':offsite['data'].get('capture_verified'),'scope':'producer_report_only_no_bundle_read'},
      remote_copy={'verified':offsite['data'].get('remote_verified'),'scope':'producer_report_only_no_remote_access'},
      restoration={'verified':None,'reason':'no_restore_evidence_in_allowed_result_source'})
    return {'host':'raspberry','schema_version':'1.1.1','observed_at':d.utc(),'source':'fixed_backup_producer_files','age_seconds':0,
      'collection_error':None,'coverage':['git_and_offsite_latest_results','individual_errors_in_evidence','no_backup_execution','no_private_manifests'],
      'data':{'git':gitdata,'offsite':offdata}}

# Output messages are approved templates. Arbitrary payloads (calendar details,
# names, addresses, IDs, paths, URLs and exception keys) are never copied.
PATTERNS=[
 ('icloud_manual_action_required',r'\bcustom_components\.icloud\.native_bridge\.ManualActionRequired:\s*waiting_for_user\s*(?:\x1b\[[0-9;]*m)*$', 'iCloud: guard local aguardando autenticação manual; necessidade de código não comprovada'),
 ('missing_field',r'\bKeyError\s*:', 'KeyError: [chave omitida]'),
 ('ipp_timeout',r'Error fetching .*Invalid response.*Timeout', 'Error fetching [alvo omitido]: Invalid response; Timeout'),
 ('unexpected_exception',r'Unexpected exception', 'Unexpected exception'),
 ('connection_refused',r'Connection refused', 'Connection refused [destino omitido]'),
 ('connection_reset',r'Connection reset', 'Connection reset [destino omitido]'),
 ('authentication',r'not authori[sz]ed|unauthori[sz]ed|authentication failed', 'Authentication failed / not authorized [identificadores omitidos]'),
 ('timeout',r'\bTimeoutError\b|\btimed out\b', 'Timeout [destino omitido]'),
 ('disk_full',r'No space left on device', 'No space left on device [caminho omitido]'),
 ('database_lock',r'database is locked', 'database is locked'),
 ('permission',r'Permission denied|PermissionError', 'Permission denied [alvo omitido]'),
 ('invalid_enum',r'Found invalid .*value', 'Found invalid enum value [valor e entidade omitidos]'),
 ('unclean_recorder',r'system could not validate.*shutdown|Ended unfinished session', 'Recorder: unclean shutdown or unfinished session'),
 ('custom_integration_warning',r'found a custom integration.*not been tested', 'Custom integration has not been tested by Home Assistant'),
]
COMPONENTS={'homeassistant.components.ipp.coordinator','homeassistant.components.websocket_api.http.connection',
 'homeassistant.components.recorder.util','homeassistant.loader','homeassistant.setup','homeassistant.components.sensor',
 'homeassistant.components.google.calendar','custom_components.kia_uvo.coordinator'}

# Only reviewed public core locations are projected. Exception keys, source
# excerpts, locals, arguments and device/account identifiers are never returned.
STACK_FRAMES={
 'homeassistant/core.py':{'async_call','_execute_service'},
 'homeassistant/components/icloud/services.py':{'update_account'},
 'homeassistant/components/icloud/account.py':{'keep_alive','update_devices','__init__'},
}

def safe_frame(body):
    match=re.search(r'File "/usr/src/homeassistant/(homeassistant/[a-zA-Z0-9_/]+\.py)", line ([0-9]{1,6}), in ([a-zA-Z0-9_]+)',body)
    if match and match[3] in STACK_FRAMES.get(match[1],set()):
        return {'source':match[1],'line':int(match[2]),'function':match[3]}
    return None

def summarize_logs(service,text,start,end):
    groups={};sampled=0;errors=0;warnings=0;unclassified=0;frames=[];trace_budget=0
    for line in text.splitlines():
        stamp,_,body=line.partition(' ');epoch=timestamp(stamp)
        if epoch is None or not start<=epoch<=end:continue
        sampled+=1;body=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',body)
        if 'Traceback (most recent call last):' in body:frames=[];trace_budget=100
        elif trace_budget:trace_budget-=1
        if trace_budget:
            frame=safe_frame(body)
            if frame:frames=(frames+[frame])[-8:]
        is_error=bool(re.search(r'\b(error|fatal|exception|KeyError|TimeoutError)\b',body,re.I))
        is_warning=bool(re.search(r'\bwarn(?:ing)?\b',body,re.I));errors+=is_error;warnings+=is_warning
        match=next(((category,message) for category,pattern,message in PATTERNS if re.search(pattern,body,re.I)),None)
        if not match:
            if not (is_error or is_warning):continue
            match=('unclassified','Mensagem omitida: padrão de sanitização ainda não aprovado');unclassified+=1
        category,message=match
        representative=[]
        if category=='missing_field':
            representative=list(frames) if trace_budget else []
            if service=='homeassistant' and any(f['source']=='homeassistant/components/icloud/account.py' and f['function']=='update_devices' for f in representative):
                category='icloud_device_update_missing_key'
                message='iCloud: KeyError durante atualização de dispositivos [chave e dados pessoais omitidos]'
            frames=[];trace_budget=0
        elif is_error and 'Traceback' not in body:
            frames=[];trace_budget=0
        logger=re.search(r'\[((?:homeassistant|custom_components)\.[a-z_.]+)\]',body)
        component=logger[1] if logger and logger[1] in COMPONENTS else 'not_allowlisted_or_absent'
        key=(category,component,json.dumps(representative,sort_keys=True))
        row=groups.setdefault(key,{'category':category,'component':component,'message':message,'occurrences':0,
          'first_seen':d.utc(epoch),'last_seen':d.utc(epoch),'message_mode':'allowlisted_template_payload_omitted'})
        if representative:
            row['representative_stack']=representative
            row['stack_coverage']=['reviewed_core_locations_only','max_8_frames','exception_key_and_locals_omitted','stack_not_full_root_cause']
        row['occurrences']+=1;row['first_seen']=min(row['first_seen'],d.utc(epoch));row['last_seen']=max(row['last_seen'],d.utc(epoch))
    warning_categories={'custom_integration_warning','unclean_recorder','invalid_enum'}
    rows=sorted(groups.values(),key=lambda row:(2 if row['category']=='unclassified' else 1 if row['category'] in warning_categories else 0,row['first_seen'],row['category'],row['component']))
    return {'service':service,'status':'sampled','sampled_lines':sampled,'error_lines':errors,'warning_lines':warnings,
      'unclassified_lines':unclassified,'events':rows,'counts_overlap':True,'recurrence_scope':'lines_in_window_not_unique_incidents'}

def logs(args,run=bounded_command,now=None):
    now=time.time() if now is None else now
    if args.get('service') not in d.SERVICES or set(args)-{'host','service','window_minutes','window_end','offset','expected_digest'}:raise ValueError('invalid_parameters')
    minutes=args.get('window_minutes',60);offset=args.get('offset',0)
    if type(minutes) is not int or minutes not in (15,60,240) or type(offset) is not int or not 0<=offset<=1000:raise ValueError('invalid_parameters')
    end=timestamp(args['window_end']) if 'window_end' in args else now
    if end is None or not now-86400<=end<=now+2:raise ValueError('invalid_parameters')
    if offset and ('window_end' not in args or not re.fullmatch(r'[a-f0-9]{64}',args.get('expected_digest',''))):raise ValueError('page_anchor_required')
    start=end-minutes*60
    try:
        text=run(['/usr/bin/docker','logs','--timestamps','--since',d.utc(start),'--until',d.utc(end),'--tail','1000',args['service']])
        data=summarize_logs(args['service'],text,start,end)
        digest=hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()
        if args.get('expected_digest',digest)!=digest:raise ValueError('log_window_changed_restart_pagination')
        total=len(data['events']);data['events']=data['events'][offset:offset+5]
        data.update(total_groups=total,next_offset=offset+5 if offset+5<total else None,digest=digest,
          window_start=d.utc(start),window_end=d.utc(end),truncated=data['sampled_lines']>=1000,
          pagination_note='reuse_window_end_and_digest; rotation can invalidate cursor')
        error=None
    except (OSError,ValueError,subprocess.SubprocessError) as ex:
        if isinstance(ex,ValueError) and str(ex)=='log_window_changed_restart_pagination':raise
        data={'service':args['service'],'status':'unavailable','events':[],'sampled_lines':None,'error_lines':None,'warning_lines':None};error=cause(ex)
    return {'host':'raspberry','schema_version':'1.1.1','observed_at':d.utc(now),'age_seconds':0,'source':'docker.logs.allowlisted_templates',
            'collection_error':error,'coverage':['single_service','max_1000_lines_256KiB','no_raw_messages','no_private_payloads','unsupported_patterns_omitted'],
            'data':data}

def host():
    result=d.host_diagnostics()
    if result['throttling']['collection_error']:
        result['throttling']['collection_error']='device_unavailable_to_unprivileged_private_devices_broker'
        result['throttling']['coverage']+=['vcio_gencmd_requires_device_access','no_permission_escalation_attempted']
    return {'host':'raspberry','schema_version':'1.1.0','observed_at':d.utc(),'age_seconds':0,'source':'fixed_host_collectors',
            'collection_error':None,'coverage':['per_measurement_errors_in_evidence'],'evidence':result}

def handle(name,args):
    if not isinstance(args,dict) or args.get('host')!='raspberry':raise ValueError('invalid_parameters')
    if name=='log_summary':return logs(args)
    if set(args)!={'host'}:raise ValueError('invalid_parameters')
    if name=='backup_results':return backups()
    if name=='host_diagnostics':return host()
    raise ValueError('invalid_parameters')
