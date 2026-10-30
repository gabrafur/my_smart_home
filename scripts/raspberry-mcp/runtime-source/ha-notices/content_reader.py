"""Render closed diagnostic tokens; never copy arbitrary strings from a snapshot."""
import json
from pathlib import Path
C=json.loads(Path(__file__).with_name('diagnostic_templates.json').read_text())
O=json.loads(Path(__file__).with_name('operational_notice_templates.json').read_text())
if (type(O) is not dict or set(O) != {'schema_version','fragments'} or type(O['schema_version']) is not int
        or O['schema_version'] != 1 or type(O['fragments']) is not dict or len(O['fragments']) > 16
        or any(type(k) is not str or not k.startswith('op_') or k in C['fragments']
               or type(v) is not str or not 0 < len(v) <= 256 for k,v in O['fragments'].items())):
    raise ValueError('invalid_operational_catalog')
C['fragments'].update(O['fragments'])

def codes(value,limit=16):
    if not isinstance(value,list)or len(value)>limit or any(not isinstance(x,str)or x not in C['fragments']for x in value):raise ValueError('invalid_codes')
    return value

def redactions(value):
    if not isinstance(value,list)or len(value)>32:raise ValueError('invalid_redactions')
    if any(not isinstance(x,dict)or set(x)!={'field','reason'}or x['field']not in C['redaction_fields']or x['reason']not in C['redaction_reasons']for x in value):raise ValueError('invalid_redactions')
    return value

def render(value):return ' '.join(C['fragments'][x]for x in codes(value))

def count_frames(value):return len(value['stack'])+sum(count_frames(x)for x in value.get('causes',[]))

def error(value,depth=0):
    if not isinstance(value,dict)or value.get('exception_type')not in [None,*C['error_types']]:raise ValueError('invalid_error')
    frames=value.get('stack');redacted=redactions(value.get('redacted_fields'))
    if not isinstance(frames,list)or len(frames)>6:raise ValueError('invalid_stack')
    safe=[]
    for row in frames:
        if (not isinstance(row,dict)or set(row)!={'source','line','function'}or row['source']not in C['stack_sources']or row['function']not in [None,*C['stack_functions']]or not(row['line']is None or type(row['line'])is int and 0<=row['line']<=999999)):raise ValueError('invalid_stack')
        safe.append({k:row[k]for k in ('source','line','function')})
    chain=value.get('causes',[])
    if not isinstance(chain,list)or len(chain)>1 or depth>=2 and chain:raise ValueError('invalid_cause_chain')
    children=[error(child,depth+1)for child in chain]
    if len(safe)+sum(count_frames(child)for child in children)>6:raise ValueError('stack_limit')
    return {'causes':children,'exception_type':value['exception_type'],'message':render(value.get('message_codes')),'reason':[C['fragments'][x]for x in codes(value.get('reason_codes'))],
        'stack':safe,'redacted_fields':redacted,'collection_error':None if value.get('collection_error')is None else'exception_or_stack_not_present'}

def project(value):
    base={'title':None,'message':None,'integration_names':[],'error_type':None,'reason':[],'correction_guidance':None,'redacted_fields':[],
          'sanitized_content_available':False,'raw_content_withheld':True,'content_collection_error':'sanitized_content_not_observed','associated_errors':[]}
    if not isinstance(value,dict):return base
    try:
        if value.get('schema_version')!=1 or value.get('raw_content_persisted')is not False or value.get('rendering')!='reviewed_diagnostic_fragments_only':raise ValueError('invalid_content')
        redacted=redactions(value.get('redacted_fields'));e=error(value.get('error'));guidance=value.get('guidance_code')
        if guidance not in ('check_integration','check_manual_auth','check_switch','check_core_compatibility','check_backup','check_service','op_check_storage_growth','op_check_codex_capacity'):raise ValueError('invalid_guidance')
        title=render(value.get('title_codes'));message=render(value.get('message_codes'))
        if any(r['field']=='title'for r in redacted):title+=' '+C['fragments']['redacted']
        if any(r['field']=='message'for r in redacted):message+=' '+C['fragments']['redacted']
        base.update(title=title,message=message,integration_names=[C['fragments'][x]for x in codes(value.get('integration_codes'))],error_type=e['exception_type'],
            reason=[C['fragments'][x]for x in codes(value.get('reason_codes'))],correction_guidance=C['fragments'][guidance],redacted_fields=redacted,
            sanitized_content_available=True,content_collection_error=None,guidance_basis='reviewed_diagnostic_template_not_execution',rendering='reviewed_diagnostic_fragments_only')
        if not e['collection_error']:base['associated_errors']=[{**e,'association':'embedded_in_notification','association_is_root_cause_proof':False}]
    except (ValueError,TypeError,KeyError):base['content_collection_error']='sanitized_content_invalid_or_unsupported'
    return base

def context(value):
 if not isinstance(value,dict):return {'flow':None,'node':None,'collection_error':'reviewed_context_not_retained'}
 flow=value.get('flow');node=value.get('node')
 if flow not in [None,*C['context_flows']]or node not in [None,*C['context_nodes']]:raise ValueError('invalid_context')
 return {'flow':None if flow is None else {'id':flow,'name':C['context_flows'][flow]},'node':None if node is None else {'id':node,'name':C['context_nodes'][node]},'collection_error':None if flow and node else 'reviewed_context_partial'}
