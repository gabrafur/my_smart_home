"""Strict read boundary: never expose unknown fields or arbitrary text from HA."""
import importlib.util
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import time

_spec=importlib.util.spec_from_file_location('_ha_notices_content_renderer',Path(__file__).with_name('content_reader.py'))
content=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(content)
ASSOCIATED=Path('/mnt/data/docker/nodered/.notification-diagnostics.json')

SNAPSHOT = Path('/var/lib/raspberry-ha-notices/public/snapshot.json')
LABELS = {
    'external': {'Iluminação externa'}, 'backup': {'Backup', 'Backup recusado pela verificação de segurança'},
    'global_observer': {'Observador de automações'}, 'smart_home_proactive_test': {'TESTE de observabilidade'},
    'icloud_auth': {'iCloud requer atenção à autenticação'},
    'unclassified': {'Notificação persistente; conteúdo não exportado'},
}
ERRORS = {'starting','connection_failed','connection_closed','auth_failed','credential_role_refused','subscription_refused',
          'invalid_response','pong_timeout','storage_failed','resource_budget_exceeded'}
STORAGE_NOTICE_ID = hashlib.sha256(b'raspberry_storage_health').hexdigest()


def reviewed_identifier_diagnostic(identifier, diagnostic):
    """Fixed public producer identity, never reconstruction of an unknown body.

    Do not infer severity, values, cleanup execution or current disk health from
    an identifier. This reader-only fallback never alters source subscriptions.
    """
    body_available = bool(diagnostic.get('message')) and not any(
        row.get('field') == 'message' for row in diagnostic.get('redacted_fields', []))
    if identifier != STORAGE_NOTICE_ID or body_available:
        return diagnostic
    return {**diagnostic,
            'title': 'Raspberry Pi — aviso de armazenamento',
            'message': 'O produtor Storage Health publicou um aviso. O conteúdo e a severidade desta revisão não estão disponíveis neste snapshot.',
            'correction_guidance': 'Consultar storage_health em maintenance_capabilities e conferir origem, idade e cobertura. Exigir dry-run antes de limpeza; preservar backups e bancos de dados.',
            'guidance_basis': 'reviewed_exact_public_producer_identifier_not_notice_body',
            'sanitized_content_available': True,
            'content_collection_error': 'notice_body_not_retained_as_reviewed_tokens',
            'raw_content_withheld': True,
            'identifier_diagnostic_only': True}


def iso(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError('invalid_time')
    parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('invalid_time')
    return parsed.timestamp()


def notice(row):
    if (not isinstance(row, dict) or row.get('category') not in LABELS or
            row.get('summary') not in LABELS[row['category']] or
            row.get('category_basis') not in ('identifier_exact','identifier_prefix','untrusted_text_pattern','unknown') or
            any(not isinstance(row.get(k),str) or not re.fullmatch('[a-f0-9]{64}',row[k]) for k in ('id','revision')) or
            row.get('content_withheld') is not True):
        raise ValueError('invalid_notice')
    iso(row['observed_at'])
    if row.get('created_or_updated_at') is not None:
        iso(row['created_or_updated_at'])
    diagnostic = reviewed_identifier_diagnostic(row['id'], content.project(row.get('diagnostics')))
    return {**diagnostic, **{k: row[k] for k in ('id','revision','observed_at','created_or_updated_at','category','summary','category_basis')},
            'source':'homeassistant.persistent_notification','origin':'not_provided_by_HA',
            'content_withheld':True,'destination_delivery':'not_applicable'}


def read(path):
    directory=os.open('/',os.O_PATH|os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:-1]:
            nxt=os.open(part,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory);directory=nxt
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,dir_fd=directory)
        try:
            info = os.fstat(fd)
            owner=1000 if path==ASSOCIATED else pwd.getpwnam('raspberry-ha-notices').pw_uid if path==SNAPSHOT else os.getuid()
            bad_mode=stat.S_IMODE(info.st_mode)!=0o644 if path==ASSOCIATED else bool(info.st_mode & 0o027)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=owner or info.st_nlink != 1 or bad_mode or info.st_size > (65536 if path==ASSOCIATED else 524288):
                raise ValueError('unsafe_snapshot')
            return os.read(fd, 524289)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def attach_associated(rows,now):
    try:
        data=json.loads(read(ASSOCIATED))
        if data.get('schema_version')!=1 or data.get('source')!='nodered.sanitized_notification_diagnostics' or not isinstance(data.get('records'),list)or len(data['records'])>32:raise ValueError('invalid_association')
        by={}
        for record in data['records']:
            if not isinstance(record,dict)or not re.fullmatch('[a-f0-9]{64}',record.get('notification_id','')):raise ValueError('invalid_association')
            at=iso(record['observed_at'])
            if at>now+1:raise ValueError('future_association')
            if now-at>86400:continue
            safe=content.error(record.get('error'));safe['context']=content.context(record.get('context'));safe.update(observed_at=record['observed_at'],association='exact_canonical_notification_id_latest_diagnostic',association_is_original_trigger_proof=False,association_is_root_cause_proof=False)
            by[record['notification_id']]=safe
        collection_error=None
    except (OSError,ValueError,TypeError,KeyError):
        by={};collection_error='associated_diagnostic_not_available_or_invalid'
    for row in rows:
        safe=by.get(row['id'])
        if safe is not None:
            row['associated_errors']=[safe]
            row['latest_associated_error_type']=safe['exception_type']
            row['latest_associated_error_reason']=safe['reason']
            row['latest_associated_error_basis']='latest_exact_ID_diagnostic_not_original_trigger'
            row['associated_correction_guidance']=content.C['fragments']['check_service']if content.C['fragments']['service_unavailable']in safe['reason']else None
        row['associated_errors_collection_error']=collection_error or (None if row['associated_errors']else'exact_associated_error_not_retained')
        row['associated_errors_coverage']='latest_exact_ID_only;max_24h;no_private_history_or_raw_logs;not_recovery_proof'


def evidence(args, path=SNAPSHOT, clock=time.time):
    if (not isinstance(args,dict) or set(args)-{'host','offset','expected_digest','notification_id'} or args.get('host')!='raspberry'
            or type(args.get('offset',0)) is not int or not 0<=args.get('offset',0)<=512):
        raise ValueError('invalid_parameters')
    expected=args.get('expected_digest')
    if expected is not None and (not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected)):
        raise ValueError('invalid_parameters')
    identifier=args.get('notification_id')
    if identifier is not None and (not isinstance(identifier,str) or not re.fullmatch('[a-f0-9]{64}',identifier) or args.get('offset',0)):
        raise ValueError('invalid_parameters')
    offset=args.get('offset',0)
    if offset and expected is None:
        raise ValueError('snapshot_digest_required')
    now=clock()
    result={'source':'ha_persistent_notification_observer','observed_at':None,'age_seconds':None,
            'state':'unknown','collection_error':None,'notifications':[],'next_offset':None,
            'coverage':['sanitized_persistent_notifications','not_mobile_delivery_receipts',
                        'notification_removal_not_recovery','no_live_HA_queries_from_MCP']}
    try:
        raw=read(path);data=json.loads(raw);stamp=iso(data['observed_at']);age=now-stamp
        if data.get('schema_version')!=1 or not isinstance(data.get('notifications'),list) or len(data['notifications'])>512:
            raise ValueError('invalid_snapshot')
        rows=[notice(row) for row in data['notifications']]
        attach_associated(rows,now)
        canonical=json.dumps(rows,sort_keys=True,separators=(',',':')).encode()
        digest=hashlib.sha256(canonical).hexdigest()
        if expected is not None and expected!=digest:
            raise ValueError('snapshot_changed')
        error=data.get('collection_error')
        if error is not None and error not in ERRORS:
            raise ValueError('invalid_snapshot')
        transport=iso(data['last_transport_confirmation_at']) if data.get('last_transport_confirmation_at') else None
        if age < -1 or (transport is not None and transport>now+1):
            state,error='unknown','clock_reconciliation_required'
        elif age>20:
            state,error='stale','collector_heartbeat_stale'
        elif error:
            state='collection_failed'
        elif data.get('connection_state')!='subscribed' or transport is None or now-transport>15:
            state,error='unknown','transport_confirmation_missing'
        else:
            state='observed'
        if identifier is not None:
            rows=[row for row in rows if row['id']==identifier]
            if not rows:
                tombstones=[e for e in data.get('events',[]) if isinstance(e,dict) and e.get('object_id')==identifier and e.get('phase')=='removed']
                removed=max(tombstones,key=lambda e:e.get('sequence',-1)) if tombstones else None
                removed_at=removed.get('observed_at')if removed else None
                if removed_at is not None:iso(removed_at)
                rows=[{'id':identifier,'notification_state':'removed'if removed else'unavailable','last_observed_state':'removed'if removed else'not_in_retained_snapshot','removed_at':removed_at,'title':None,'message':None,'raw_content_withheld':True,'associated_errors':[],'collection_error':None if removed else'not_current_or_retained_removal','recovery_proven':False}]
        for row in rows:
            previous=row.get('notification_state','current')
            row['last_observed_state']=row.get('last_observed_state',previous)
            row['notification_state']=previous if state=='observed'else'unavailable'
            row['collection_error']=error or row.get('collection_error')
            at=row.get('created_or_updated_at')
            row['notification_age_seconds']=round(max(0,now-iso(at)),3)if at else None
            row['recovery_proven']=False
            for associated in row.get('associated_errors',[]):
                associated['age_seconds']=round(max(0,now-iso(associated['observed_at'])),3)if associated.get('observed_at')else None
        page=[];budget=56000
        for row in rows[offset:offset+16]:
            size=len(json.dumps(row,ensure_ascii=True,separators=(',',':')).encode())
            if page and size>budget:break
            if size>budget:raise ValueError('single_notice_response_limit')
            page.append(row);budget-=size
        result.update(total_current_notifications=len(data['notifications']),query_kind='notification_id'if identifier is not None else'page',observed_at=data['observed_at'],age_seconds=max(0,round(age,3)),state=state,
                      collection_error=error,notifications=page,count=len(rows),digest=digest,page_limit=16,response_byte_limit=60000,
                      next_offset=offset+len(page) if offset+len(page)<len(rows) else None)
    except FileNotFoundError:
        result['collection_error']='not_collected'
    except PermissionError:
        result['collection_error']='collection_read_denied'
    except (OSError,ValueError,TypeError,KeyError) as error:
        result['collection_error']='snapshot_changed' if isinstance(error,ValueError) and str(error)=='snapshot_changed' else 'invalid_snapshot'
        result['notifications']=[]
    return result
