"""Bounded durable source-to-consumer aggregation, without house policy."""
import copy,hashlib,re
from protocol import KINDS,STAT_COLUMNS
from receiver_ledger import FAULTS,LedgerUnavailable,encode,stringify

HEADERS=('frames','duplicates','sessions','source_epochs','report_gaps','unknown_epoch_tails',
         'source_clock_faults','source_send_failures',
         'ack_rejections','ack_clock_conflicts')
NATIVE_HEADERS=HEADERS[:-2]
def need(ok):
    if not ok:raise LedgerUnavailable('handoff_state_invalid')from None
def count(value):return type(value)is int and 0<=value<2**128
def ns(value):return type(value)is int and 0<=value<2**64
def hex64(value):return type(value)is str and re.fullmatch('[a-f0-9]{64}',value)is not None
def closed(value,fields):need(type(value)is dict and set(value)==set(fields))

def totals():
    return {**dict.fromkeys(HEADERS,0),'faults':dict.fromkeys(FAULTS,0),
            'stats':{k:dict.fromkeys(STAT_COLUMNS,0)for k in KINDS}}
def empty(domain):
    return {'clock_domain_id':domain,'clock_domain_conflict':False,'first_reader_ns':None,
            'last_reader_ns':None,'counts':totals(),'oldest_source_ns':dict.fromkeys(KINDS),
            'max_socket_ns':dict.fromkeys(KINDS)}
def initial(domain):
    return {'version':1,'next_bucket_id':1,'acked_buckets':0,'ack_rejections':0,'ack_clock_conflicts':0,
            'active':empty(domain),'published':None,'acked_counts':totals(),'last_ack':None}
def nonempty(bucket):
    c=bucket['counts']
    return any(c[k]for k in HEADERS)or any(c['faults'].values())or any(v for row in c['stats'].values()for v in row.values())
def touch(bucket,at,domain):
    if not nonempty(bucket):
        bucket['clock_domain_id']=domain
    elif bucket['clock_domain_id']!=domain or (bucket['last_reader_ns']is not None and at<bucket['last_reader_ns']):
        bucket['clock_domain_id']=None;bucket['clock_domain_conflict']=True
    if bucket['first_reader_ns']is None:bucket['first_reader_ns']=at
    bucket['last_reader_ns']=at
def add_totals(target,source):
    for key in HEADERS:target[key]+=source[key]
    for key in FAULTS:target['faults'][key]+=source['faults'][key]
    for kind in KINDS:
        for field in STAT_COLUMNS:target['stats'][kind][field]+=source['stats'][kind][field]

def source_counts(body):
    result=totals()
    if body is None:return result
    result.update(frames=body['accepted_frames'],duplicates=body['duplicate_frames'],sessions=body['reader_sessions'])
    result['faults']=copy.deepcopy(body['faults'])
    s=body['state']
    if s is not None:
        result.update(source_epochs=s['epoch'],report_gaps=s['past_report_gaps']+s['report_gaps'],unknown_epoch_tails=s['unknown_epoch_tails'])
        result['source_clock_faults']=s['past_clock_faults']+s['clock_faults']
        result['source_send_failures']=s['past_send_failures']+s['send_failures']
        for kind in KINDS:
            for field in STAT_COLUMNS:
                result['stats'][kind][field]=s['stats'][kind][field]+s['past_stats'][kind][field]
    return result

def observe(h,old,body,at):
    before=source_counts(old);after=source_counts(body);delta=totals();changed=False
    for key in NATIVE_HEADERS:
        n=after[key]-before[key];need(count(n));delta[key]=n;changed|=n>0
    need(delta['frames']<=1)
    for key in FAULTS:
        n=after['faults'][key]-before['faults'][key];need(count(n));delta['faults'][key]=n;changed|=n>0
    for kind in KINDS:
        for field in STAT_COLUMNS:
            n=after['stats'][kind][field]-before['stats'][kind][field];need(count(n));delta['stats'][kind][field]=n;changed|=n>0
    if not changed:return
    active=h['active'];touch(active,at,body['clock_domain_id'])
    add_totals(active['counts'],delta)
    if delta['frames']:
        state=body['state'];need(state is not None)
        for kind in KINDS:
            batch=state['last_batch'][kind]
            need(all(delta['stats'][kind][field]==batch[field]for field in STAT_COLUMNS))
            if batch['timed']:
                oldest=state['last_reader_ns']-batch['max_source_to_reader_ns'];need(ns(oldest))
                old=active['oldest_source_ns'][kind]
                active['oldest_source_ns'][kind]=oldest if old is None else min(old,oldest)
                old=active['max_socket_ns'][kind]
                active['max_socket_ns'][kind]=batch['max_source_to_reader_ns']if old is None else max(old,batch['max_source_to_reader_ns'])

def packet_from(published):
    return {'schema_version':1,'body':stringify(copy.deepcopy(published['value'])),'sha256':published['sha256']}
def freeze(h,at,domain):
    if h['published']is not None:return packet_from(h['published']),False
    if not nonempty(h['active']):return None,False
    need(ns(at)and hex64(domain)and h['next_bucket_id']<2**64)
    value={'bucket_id':h['next_bucket_id'],'aggregate':copy.deepcopy(h['active']),
           'published_at_ns':at,'publisher_clock_domain_id':domain,'previous_ack':copy.deepcopy(h['last_ack'])}
    digest=hashlib.sha256(encode(stringify(value)).encode('ascii')).hexdigest()
    h['published']={'value':value,'sha256':digest}
    h['next_bucket_id']+=1;h['active']=empty(domain)
    return packet_from(h['published']),True

def reject_ack(h,at,domain):
    touch(h['active'],at,domain);h['ack_rejections']+=1;h['active']['counts']['ack_rejections']+=1
    return 'rejected',True
def acknowledge(h,ack,at,domain):
    need(ns(at)and hex64(domain))
    valid=(type(ack)is dict and set(ack)=={'schema_version','bucket_id','sha256'}
        and type(ack['schema_version'])is int and ack['schema_version']==1
        and type(ack['bucket_id'])is str and re.fullmatch(r'(?:0|[1-9][0-9]{0,19})',ack['bucket_id'])is not None
        and int(ack['bucket_id'])<2**64 and hex64(ack['sha256']))
    if not valid:return reject_ack(h,at,domain)
    number=int(ack['bucket_id']);last=h['last_ack']
    if last and number<last['bucket_id']:return 'stale_ignored',False
    if last and number==last['bucket_id']:
        return ('duplicate',False)if ack['sha256']==last['sha256']else reject_ack(h,at,domain)
    frozen=h['published']
    if frozen is None:return reject_ack(h,at,domain)
    value=frozen['value']
    if number!=value['bucket_id']or ack['sha256']!=frozen['sha256']:return reject_ack(h,at,domain)
    bucket=value['aggregate']
    ordered=(domain==value['publisher_clock_domain_id']==bucket['clock_domain_id']
             and not bucket['clock_domain_conflict']and at>=value['published_at_ns']
             and (bucket['last_reader_ns']is None or value['published_at_ns']>=bucket['last_reader_ns'])
             and (bucket['last_reader_ns']is None or at>=bucket['last_reader_ns']))
    receipt={'bucket_id':number,'sha256':frozen['sha256'],'ack_at_ns':at,'ack_clock_domain_id':domain,
             'publication_to_ack_ns':at-value['published_at_ns']if ordered else None,
             'clock_ordered':ordered,'source_to_ack':{}}
    for kind in KINDS:
        row=bucket['counts']['stats'][kind];oldest=bucket['oldest_source_ns'][kind]
        known=row['timed']if ordered and oldest is not None and oldest<=at else 0
        receipt['source_to_ack'][kind]={'observed':row['observed'],'timed':known,
            'timing_unknown':row['observed']-known,'upper_ns':at-oldest if known else None}
    add_totals(h['acked_counts'],bucket['counts']);h['acked_buckets']+=1
    h['last_ack']=receipt;h['published']=None
    if not ordered:
        touch(h['active'],at,domain)
        h['ack_clock_conflicts']+=1;h['active']['counts']['ack_clock_conflicts']+=1
    return 'accepted',True

def validate_totals(c):
    closed(c,set(HEADERS)|{'faults','stats'})
    need(all(count(c[k])for k in HEADERS));closed(c['faults'],FAULTS)
    need(all(count(v)for v in c['faults'].values()));closed(c['stats'],KINDS)
    for row in c['stats'].values():
        closed(row,STAT_COLUMNS);need(all(count(v)for v in row.values()))
        need(row['expected']==row['observed']+row['missing']and row['observed']==row['timed']+row['timing_unknown']
             and row['missing']==row['source_dropped']+row['transport_missing'])
def validate_bucket(b):
    closed(b,{'clock_domain_id','clock_domain_conflict','first_reader_ns','last_reader_ns','counts','oldest_source_ns','max_socket_ns'})
    need(type(b['clock_domain_conflict'])is bool)
    need((b['clock_domain_conflict']and b['clock_domain_id']is None)or(not b['clock_domain_conflict']and hex64(b['clock_domain_id'])))
    validate_totals(b['counts'])
    if nonempty(b):
        need(ns(b['first_reader_ns'])and ns(b['last_reader_ns']))
        if not b['clock_domain_conflict']:need(b['first_reader_ns']<=b['last_reader_ns'])
    else:need(b['first_reader_ns']is None and b['last_reader_ns']is None)
    for key in ['oldest_source_ns','max_socket_ns']:
        closed(b[key],KINDS)
        for kind in KINDS:
            v=b[key][kind]
            need((b['counts']['stats'][kind]['timed']==0 and v is None)or(b['counts']['stats'][kind]['timed']>0 and ns(v)))
    if not b['clock_domain_conflict']:
        for v in b['oldest_source_ns'].values():
            if v is not None:need(v<=b['last_reader_ns'])
def validate_receipt(r):
    closed(r,{'bucket_id','sha256','ack_at_ns','ack_clock_domain_id','publication_to_ack_ns','clock_ordered','source_to_ack'})
    need(ns(r['bucket_id'])and r['bucket_id']>0 and hex64(r['sha256'])and ns(r['ack_at_ns'])and hex64(r['ack_clock_domain_id']))
    need(type(r['clock_ordered'])is bool)
    need(ns(r['publication_to_ack_ns'])if r['clock_ordered']else r['publication_to_ack_ns']is None)
    closed(r['source_to_ack'],KINDS)
    for row in r['source_to_ack'].values():
        closed(row,{'observed','timed','timing_unknown','upper_ns'})
        need(all(count(row[k])for k in ['observed','timed','timing_unknown'])and row['observed']==row['timed']+row['timing_unknown'])
        need((row['timed']==0 and row['upper_ns']is None)or(row['timed']>0 and ns(row['upper_ns'])and r['clock_ordered']))
def validate(h,body):
    closed(h,{'version','next_bucket_id','acked_buckets','ack_rejections','ack_clock_conflicts','active','published','acked_counts','last_ack'})
    need(type(h['version'])is int and h['version']==1)
    need(ns(h['next_bucket_id'])and h['next_bucket_id']>0 and count(h['acked_buckets'])
         and count(h['ack_rejections'])and count(h['ack_clock_conflicts']))
    validate_bucket(h['active']);validate_totals(h['acked_counts'])
    r=h['last_ack']
    if r is not None:validate_receipt(r);need(r['bucket_id']==h['acked_buckets'])
    else:need(h['acked_buckets']==0)
    combined=copy.deepcopy(h['acked_counts']);add_totals(combined,h['active']['counts'])
    frozen=h['published']
    if frozen is not None:
        closed(frozen,{'value','sha256'});need(hex64(frozen['sha256']))
        value=frozen['value'];closed(value,{'bucket_id','aggregate','published_at_ns','publisher_clock_domain_id','previous_ack'})
        need(type(value['bucket_id'])is int and value['bucket_id']==h['next_bucket_id']-1
             and ns(value['published_at_ns'])and hex64(value['publisher_clock_domain_id'])and value['previous_ack']==r)
        validate_bucket(value['aggregate']);need(nonempty(value['aggregate']))
        need(hashlib.sha256(encode(stringify(value)).encode('ascii')).hexdigest()==frozen['sha256'])
        add_totals(combined,value['aggregate']['counts'])
    need(h['next_bucket_id']==h['acked_buckets']+(1 if frozen else 0)+1)
    expected=source_counts(body);expected['ack_rejections']=h['ack_rejections'];expected['ack_clock_conflicts']=h['ack_clock_conflicts']
    need(combined==expected)
