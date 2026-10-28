"""Unarmed native MQTT metadata protocol. No broker, credential or device IO."""
import copy
import hashlib
import json
import re

KINDS=('publish_in','publish_out','connect','disconnect','subscribe','unsubscribe','client_offline')
FIELDS={'v','instance','started_ns','frame_seq','event_seq','totals','source_dropped',
        'clock_faults','send_failures','emitted_ns','events'}
MAX_FRAME_BYTES=32768
MAX_EVENTS=256
STAT_COLUMNS=('expected','observed','missing','source_dropped','transport_missing','timed','timing_unknown')


class Invalid(ValueError):
    pass


def need(ok, reason):
    if not ok:
        raise Invalid(reason)


def uint(value):
    need(type(value)is str and re.fullmatch(r'(?:0|[1-9][0-9]{0,19})',value) is not None,'integer_invalid')
    out=int(value)
    need(out<2**64,'integer_invalid')
    return out


def optional_uint(value):
    return None if value is None else uint(value)


def closed(value, keys):
    need(type(value)is dict and set(value)==set(keys),'schema_invalid')


def validate_state(state):
    keys={'version','instance','epoch','started_ns','previous_epoch_tail_unknown',
          'last_frame_seq','last_event_seq','last_frame_hash','last_totals',
          'last_source_dropped','last_reader_ns','last_emitted_ns','clock_faults',
          'send_failures','report_gaps','stats','last_batch','full24h_proven',
          'past_stats','past_report_gaps','past_clock_faults','past_send_failures','unknown_epoch_tails'}
    need(type(state)is dict,'accounting_state_invalid')
    version=state.get('version')
    need(type(version)is int and version in(2,3),'accounting_state_invalid')
    if version==3:keys|={'source_closed','last_source_wire_version'}
    need(keys<=set(state)<=keys|{'previous_epoch_summary'},'accounting_state_invalid')
    def count(value):
        return type(value)is int and 0<=value<2**128
    def stats(value):
        closed(value,KINDS)
        for row in value.values():
            closed(row,set(STAT_COLUMNS)|{'max_source_to_reader_ns'})
            need(all(count(row[k])for k in STAT_COLUMNS),'accounting_state_invalid')
            need(row['expected']==row['observed']+row['missing']
                 and row['observed']==row['timed']+row['timing_unknown']
                 and row['missing']==row['source_dropped']+row['transport_missing'],'accounting_state_invalid')
            maximum=row['max_source_to_reader_ns']
            need((maximum is None and row['timed']==0)or(count(maximum)and row['timed']>0),'accounting_state_invalid')
    need(state['full24h_proven']is False,'accounting_state_invalid')
    if version==3:
        need(type(state['source_closed'])is bool
             and type(state['last_source_wire_version'])is int
             and state['last_source_wire_version']in(1,2)
             and(not state['source_closed']or state['last_source_wire_version']==2),'accounting_state_invalid')
    need(type(state['instance'])is str and re.fullmatch('[a-f0-9]{32}',state['instance'])is not None,'accounting_state_invalid')
    need(type(state['last_frame_hash'])is str and re.fullmatch('[a-f0-9]{64}',state['last_frame_hash'])is not None,'accounting_state_invalid')
    for name in ['epoch','last_frame_seq','last_event_seq','last_reader_ns','clock_faults',
                 'send_failures','report_gaps','past_report_gaps','past_clock_faults','past_send_failures','unknown_epoch_tails']:
        need(count(state[name]),'accounting_state_invalid')
    need(state['epoch']>0 and state['last_frame_seq']>0,'accounting_state_invalid')
    need(type(state['previous_epoch_tail_unknown'])is bool,'accounting_state_invalid')
    if version==2:
        need(state['unknown_epoch_tails']==state['epoch']-1
             and state['previous_epoch_tail_unknown']==(state['epoch']>1),'accounting_state_invalid')
    else:
        need(0<=state['unknown_epoch_tails']<=state['epoch']-1,'accounting_state_invalid')
        if state['epoch']==1:need(state['previous_epoch_tail_unknown']is False,'accounting_state_invalid')
        elif state['previous_epoch_tail_unknown']:need(state['unknown_epoch_tails']>0,'accounting_state_invalid')
        else:need(state['unknown_epoch_tails']<=state['epoch']-2,'accounting_state_invalid')
    for name in ['started_ns','last_emitted_ns']:
        need(state[name]is None or count(state[name]),'accounting_state_invalid')
    for name in ['last_totals','last_source_dropped']:
        closed(state[name],KINDS)
        need(all(count(v)for v in state[name].values()),'accounting_state_invalid')
    need(sum(state['last_totals'].values())==state['last_event_seq'],'accounting_state_invalid')
    for name in ['stats','last_batch','past_stats']:
        stats(state[name])
    if state['epoch']==1:
        need(state['past_report_gaps']==state['past_clock_faults']==state['past_send_failures']==0
             and all(row[field]==0 for row in state['past_stats'].values()for field in STAT_COLUMNS),'accounting_state_invalid')
    if 'previous_epoch_summary'in state:
        summary=state['previous_epoch_summary']
        closed(summary,{'epoch','stats','report_gaps','clock_faults','send_failures','tail_unknown'})
        need(count(summary['epoch'])and 0<summary['epoch']<state['epoch']and count(summary['report_gaps'])
             and type(summary['tail_unknown'])is bool
             and summary['tail_unknown']==state['previous_epoch_tail_unknown'],'accounting_state_invalid')
        stats(summary['stats'])
        need(count(summary['clock_faults'])and summary['clock_faults']<=state['past_clock_faults']
             and count(summary['send_failures'])and summary['send_failures']<=state['past_send_failures'],'accounting_state_invalid')


def decode(raw):
    need(type(raw)is bytes and 0<len(raw)<=MAX_FRAME_BYTES,'frame_size_invalid')
    try:
        # Duplicate keys cannot hide a private or contradictory earlier field.
        def pairs(items):
            out={}
            for key,value in items:
                need(key not in out,'duplicate_key')
                out[key]=value
            return out
        value=json.loads(raw.decode('ascii'),object_pairs_hook=pairs)
    except (UnicodeError,ValueError,RecursionError):
        raise Invalid('frame_encoding_invalid') from None
    need(type(value)is dict and type(value.get('v'))is int and value['v']in(1,2),'schema_invalid')
    version=value['v'];closed(value,FIELDS|({'final'}if version==2 else set()))
    if version==2:need(type(value['final'])is bool,'schema_invalid')
    need(type(value['instance'])is str and re.fullmatch('[a-f0-9]{32}',value['instance']) is not None,'instance_invalid')
    out={'instance':value['instance'],'wire_version':version,'final':value['final']if version==2 else False}
    for key in ['frame_seq','event_seq','clock_faults','send_failures']:
        out[key]=uint(value[key])
    need(out['frame_seq']>0,'counter_invalid')
    for key in ['started_ns','emitted_ns']:
        out[key]=optional_uint(value[key])
    for key in ['totals','source_dropped']:
        closed(value[key],KINDS)
        out[key]={kind:uint(value[key][kind])for kind in KINDS}
    need(sum(out['totals'].values())==out['event_seq'],'counter_inconsistent')
    need(all(out['source_dropped'][k]<=out['totals'][k]for k in KINDS),'counter_inconsistent')
    rows=value['events']
    need(type(rows)is list and len(rows)<=MAX_EVENTS,'event_bound_invalid')
    out['events']=[]
    seq=0
    for row in rows:
        closed(row,{'seq','kind','at_ns'})
        n=uint(row['seq'])
        need(seq<n<=out['event_seq']and row['kind']in KINDS,'event_sequence_invalid')
        out['events'].append({'seq':n,'kind':row['kind'],'at_ns':optional_uint(row['at_ns'])})
        seq=n
    return out


def accept(previous, raw, arrived_ns, *, source_binding_verified):
    """Binding is out-of-band SCM_CREDENTIALS + reviewed executable/plugin identity.

    The worker must durably count every unknown result; this pure transition
    never turns rejected frames or a caller-provided JSON flag into proof.
    Policy thresholds, availability, notifications and 24h decisions are left
    to the canonical Node-RED consumer.
    """
    safe_previous=None
    try:
        if previous is not None:
            try:
                validate_state(previous)
            except (Invalid,KeyError,TypeError):
                raise Invalid('accounting_state_invalid')from None
            safe_previous=previous
        need(source_binding_verified is True,'source_binding_unverified')
        need(type(arrived_ns)is int and 0<=arrived_ns<2**64,'reader_clock_invalid')
        f=decode(raw)
        digest=hashlib.sha256(raw).hexdigest()
        same=previous is not None and previous['instance']==f['instance']
        if same and f['frame_seq']==previous['last_frame_seq']:
            need(digest==previous['last_frame_hash'],'frame_reuse_conflict')
            return {'status':'duplicate','reason':None,'state':copy.deepcopy(previous),'full_goal_proven':False}
        prior=previous if same else None
        need(not prior or not prior.get('source_closed',False),'source_already_closed')
        need(not prior or f['wire_version']>=prior.get('last_source_wire_version',1),'source_wire_downgrade')
        oldseq=prior['last_event_seq']if prior else 0
        oldframe=prior['last_frame_seq']if prior else 0
        need(f['frame_seq']>oldframe and f['event_seq']>=oldseq,'counter_reversed')
        if prior:
            need(arrived_ns>=prior['last_reader_ns'],'reader_clock_reversed')
            need(f['clock_faults']>=prior['clock_faults'] and f['send_failures']>=prior['send_failures'],'counter_reversed')
            if f['emitted_ns']is not None and prior['last_emitted_ns']is not None:
                need(f['emitted_ns']>=prior['last_emitted_ns'],'source_clock_reversed')
        if f['emitted_ns']is not None:
            need(f['emitted_ns']<=arrived_ns,'source_clock_future')
        if f['started_ns']is not None:
            need(f['started_ns']<=arrived_ns and (f['emitted_ns']is None or f['started_ns']<=f['emitted_ns']),'source_clock_future')
        need(not prior or f['started_ns']==prior['started_ns'],'source_start_changed')
        delta={k:f['totals'][k]-(prior['last_totals'][k]if prior else 0)for k in KINDS}
        source_drop={k:f['source_dropped'][k]-(prior['last_source_dropped'][k]if prior else 0)for k in KINDS}
        need(all(delta[k]>=0 and source_drop[k]>=0 for k in KINDS),'counter_reversed')
        rows={k:[]for k in KINDS}
        unknown_clocks=0
        for row in f['events']:
            need(row['seq']>oldseq,'event_replayed')
            at=row['at_ns']
            if at is not None:
                need(at<=arrived_ns and (f['emitted_ns']is None or at<=f['emitted_ns'])
                     and (f['started_ns']is None or at>=f['started_ns']),'event_clock_invalid')
            else:
                unknown_clocks+=1
            rows[row['kind']].append(at)
        oldfaults=prior['clock_faults']if prior else 0
        need(f['clock_faults']-oldfaults>=unknown_clocks,'clock_fault_accounting_invalid')
        need(f['started_ns']is not None or f['clock_faults']>0,'clock_fault_accounting_invalid')
        need(f['emitted_ns']is not None or f['clock_faults']>oldfaults,'clock_fault_accounting_invalid')
        missing={k:delta[k]-len(rows[k])for k in KINDS}
        need(all(missing[k]>=source_drop[k]>=0 for k in KINDS),'event_count_inconsistent')
        if f['frame_seq']==oldframe+1:
            need(all(missing[k]==source_drop[k]for k in KINDS),'unexplained_consecutive_frame_loss')
        columns=STAT_COLUMNS
        stats=copy.deepcopy(prior['stats'])if prior else {k:{**dict.fromkeys(columns,0),'max_source_to_reader_ns':None}for k in KINDS}
        batch={}
        for k in KINDS:
            latencies=[arrived_ns-at for at in rows[k]if at is not None and f['emitted_ns']is not None and f['started_ns']is not None]
            batch[k]={'expected':delta[k],'observed':len(rows[k]),'missing':missing[k],
                      'source_dropped':source_drop[k],'transport_missing':missing[k]-source_drop[k],
                      'timed':len(latencies),'timing_unknown':len(rows[k])-len(latencies),
                      'max_source_to_reader_ns':max(latencies)if latencies else None}
            for field in columns:
                stats[k][field]+=batch[k][field]
            values=[v for v in [stats[k]['max_source_to_reader_ns'],batch[k]['max_source_to_reader_ns']]if v is not None]
            stats[k]['max_source_to_reader_ns']=max(values)if values else None
        epoch=previous['epoch']if same else (previous['epoch']+1 if previous else 1)
        transition_tail_unknown=bool(previous is not None and not same and not previous.get('source_closed',False))
        state={'version':3,'instance':f['instance'],'epoch':epoch,'started_ns':f['started_ns'],
               'source_closed':f['final'],'last_source_wire_version':f['wire_version'],
               'previous_epoch_tail_unknown':transition_tail_unknown or bool(prior and prior['previous_epoch_tail_unknown']),
               'last_frame_seq':f['frame_seq'],'last_event_seq':f['event_seq'],'last_frame_hash':digest,
               'last_totals':f['totals'],'last_source_dropped':f['source_dropped'],
               'last_reader_ns':arrived_ns,'last_emitted_ns':f['emitted_ns'],
               'clock_faults':f['clock_faults'],'send_failures':f['send_failures'],
               'report_gaps':(prior['report_gaps']if prior else 0)+f['frame_seq']-oldframe-1,
               'stats':stats,'last_batch':batch,'full24h_proven':False}
        past=copy.deepcopy(previous.get('past_stats'))if previous else None
        if past is None:
            past={k:{**dict.fromkeys(columns,0),'max_source_to_reader_ns':None}for k in KINDS}
        if previous is not None and not same:
            for k in KINDS:
                for field in columns:
                    past[k][field]+=previous['stats'][k][field]
                values=[v for v in [past[k]['max_source_to_reader_ns'],previous['stats'][k]['max_source_to_reader_ns']]if v is not None]
                past[k]['max_source_to_reader_ns']=max(values)if values else None
        state['past_stats']=past
        state['past_report_gaps']=(previous.get('past_report_gaps',0)if previous else 0)+(previous['report_gaps']if previous is not None and not same else 0)
        for field in ['clock_faults','send_failures']:
            state['past_'+field]=(previous['past_'+field]if previous else 0)+(previous[field]if previous is not None and not same else 0)
        state['unknown_epoch_tails']=(previous.get('unknown_epoch_tails',0)if previous else 0)+int(transition_tail_unknown)
        if previous is not None and not same:
            state['previous_epoch_summary']={'epoch':previous['epoch'],'stats':copy.deepcopy(previous['stats']),
                                             'report_gaps':previous['report_gaps'],'clock_faults':previous['clock_faults'],
                                             'send_failures':previous['send_failures'],'tail_unknown':transition_tail_unknown}
        elif prior and 'previous_epoch_summary'in prior:
            state['previous_epoch_summary']=copy.deepcopy(prior['previous_epoch_summary'])
        validate_state(state)
        return {'status':'accepted','reason':None,'state':state,'full_goal_proven':False}
    except Invalid as error:
        return {'status':'unknown','reason':str(error),'state':copy.deepcopy(safe_previous),'full_goal_proven':False}
    except (KeyError,TypeError,OverflowError):
        return {'status':'unknown','reason':'accounting_state_invalid','state':copy.deepcopy(safe_previous),'full_goal_proven':False}
