"""Immutable terminal history, separate from the bounded active journal.

Data only: no services, authority, scheduling, deletion or effect retries. The
same FileTransaction lock protects archive publication and active retirement.
"""
import copy,json,re
from deployment_files import DeploymentUnavailable
from maintenance_journal import canonical,digest,closed,hex64,uint,validate_operation,MaintenanceUnavailable as Error

MAX_ARCHIVED_OPERATIONS=4096
MAX_OPERATION_BYTES=65536
INDEX='maintenance-archive.json'
TERMINAL=('complete','cancelled','rescued')

class Archive:
    def __init__(self,transaction):self.tx=transaction

    def _read(self,name):
        try:
            self.tx._anchors();raw=self.tx._read(self.tx.state_fd,name,0o600)
            def pairs(rows):
                result={}
                for key,value in rows:
                    if key in result:raise Error('maintenance_archive_invalid')
                    result[key]=value
                return result
            value=json.loads(raw,object_pairs_hook=pairs)
            if canonical(value)!=raw:raise Error('maintenance_archive_invalid')
            return raw,value
        except FileNotFoundError:raise
        except (OSError,DeploymentUnavailable,ValueError,TypeError,RecursionError):
            raise Error('maintenance_archive_invalid')from None

    def index(self):
        try:raw,value=self._read(INDEX)
        except FileNotFoundError:return None
        try:
            closed(value,['body','sha256']);body=value['body']
            closed(body,['schema_version','revision','operations'])
            if type(body['schema_version'])is not int or body['schema_version']!=1:raise ValueError()
            uint(body['revision'],64);rows=body['operations']
            if type(rows)is not list or len(rows)>MAX_ARCHIVED_OPERATIONS:raise ValueError()
            if uint(body['revision'],64)!=len(rows):raise ValueError()
            seen=set()
            for row in rows:
                closed(row,['operation_id','operation_sha256','terminal_sha256','phase'])
                op=row['operation_id']
                if (type(op)is not str or not re.fullmatch('[a-f0-9]{32}',op)or op in seen or
                    not hex64(row['operation_sha256'])or not hex64(row['terminal_sha256'])or row['phase']not in TERMINAL):raise ValueError()
                seen.add(op)
            if not hex64(value['sha256'])or digest(body)!=value['sha256']:raise ValueError()
            return raw,value
        except (ValueError,TypeError,KeyError,Error):raise Error('maintenance_archive_invalid')from None

    def checked(self,snapshot):
        """Bind an append-only index to the active file, including crash tails."""
        body=snapshot['body']if snapshot else {'schema_version':1,'operations':[]}
        count=uint(body['archived_operations'],64)if body['schema_version']>=2 else 0
        anchor=body.get('archive_sha256');index=self.index()
        rows=index[1]['body']['operations']if index else []
        if len(rows)<count or (count==0 and anchor is not None):raise Error('maintenance_archive_anchor_changed')
        if count:
            prefix={'schema_version':1,'revision':str(count),'operations':rows[:count]}
            if digest(prefix)!=anchor:raise Error('maintenance_archive_anchor_changed')
        active={op['operation_id']:op for op in body['operations']}
        # Publication precedes active retirement. Only exact active copies may
        # occupy an index tail not yet referenced by the active anchor.
        for row in rows[count:]:
            op=active.get(row['operation_id'])
            if (op is None or digest(op)!=row['operation_sha256']or
                op['records'][-1]['sha256']!=row['terminal_sha256']or
                op['records'][-1]['body']['phase']!=row['phase']):raise Error('maintenance_archive_anchor_changed')
            if self.find(row['operation_id'])!=op:raise Error('maintenance_archive_invalid')
        return index

    def find(self,operation_id):
        if type(operation_id)is not str or not re.fullmatch('[a-f0-9]{32}',operation_id):
            raise Error('maintenance_operation_invalid')
        index=self.index()
        row=next((r for r in index[1]['body']['operations']if r['operation_id']==operation_id),None)if index else None
        if row is None:return None
        return self.load(row)[1]

    def load(self,row):
        """Load a row from a previously validated index without rescanning it."""
        operation_id=row['operation_id']
        if type(operation_id)is not str or not re.fullmatch('[a-f0-9]{32}',operation_id):
            raise Error('maintenance_operation_invalid')
        try:
            raw,value=self._read('maintenance-archive-'+operation_id+'.json')
            closed(value,['schema_version','operation','sha256'])
            if type(value['schema_version'])is not int or value['schema_version']!=1 or len(raw)>MAX_OPERATION_BYTES:raise ValueError()
            operation=validate_operation(value['operation']);last=operation['records'][-1]
            if (operation['operation_id']!=operation_id or digest(operation)!=value['sha256']or
                value['sha256']!=row['operation_sha256']or last['sha256']!=row['terminal_sha256']or
                last['body']['phase']!=row['phase']):raise ValueError()
            return raw,copy.deepcopy(operation)
        except (OSError,ValueError,TypeError,KeyError,Error):raise Error('maintenance_archive_invalid')from None

    def preserve(self,operation):
        operation=validate_operation(copy.deepcopy(operation));last=operation['records'][-1]
        if self.tx.read_only:raise Error('maintenance_read_only')
        if last['body']['phase']not in TERMINAL:raise Error('maintenance_archive_unresolved')
        old=self.index();existing=self.find(operation['operation_id'])
        if existing is not None:
            if existing!=operation:raise Error('maintenance_archive_conflict')
            return
        body=copy.deepcopy(old[1]['body'])if old else {'schema_version':1,'revision':'0','operations':[]}
        if len(body['operations'])>=MAX_ARCHIVED_OPERATIONS:raise Error('maintenance_archive_capacity_reached')
        name='maintenance-archive-'+operation['operation_id']+'.json'
        raw=canonical({'schema_version':1,'operation':operation,'sha256':digest(operation)})
        if len(raw)>MAX_OPERATION_BYTES:raise Error('maintenance_archive_capacity_reached')
        try:
            try:orphan,_=self._read(name)
            except FileNotFoundError:orphan=None
            # A crash before index publication leaves the complete active copy.
            # Reconciliation can adopt only exactly the same immutable bytes.
            if orphan is not None and orphan!=raw:raise Error('maintenance_archive_conflict')
            if orphan is None:self.tx._atomic(self.tx.state_fd,name,raw,0o600)
            if self.index()!=old:raise Error('maintenance_archive_concurrent_change')
            body['operations'].append({'operation_id':operation['operation_id'],'operation_sha256':digest(operation),
                'terminal_sha256':last['sha256'],'phase':last['body']['phase']})
            body['revision']=str(uint(body['revision'],64)+1)
            value=canonical({'body':body,'sha256':digest(body)})
            if len(value)>1048576:raise Error('maintenance_archive_capacity_reached')
            self.tx._anchors();self.tx._atomic(self.tx.state_fd,INDEX,value,0o600)
            if self.find(operation['operation_id'])!=operation:raise Error('maintenance_archive_invalid')
        except (OSError,DeploymentUnavailable):raise Error('maintenance_archive_write_uncertain')from None
