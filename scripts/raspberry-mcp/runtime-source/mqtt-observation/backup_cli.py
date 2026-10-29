"""Candidate fixed Root backup helper. Installation requires separate approval.

No free paths, facts, Docker targets, policy, authorization or timing arguments.
The host backup worker holds the canonical canvas's delegated backup intent.
"""
from pathlib import Path
import json,os,re,sys,signal,resource

STATE=Path('/var/lib/raspberry-mqtt-maintenance')

def main():
    if os.geteuid()!=0 or os.getegid()!=0 or len(sys.argv)!=3:
        raise RuntimeError('backup_helper_request_invalid')
    action,operation_id=sys.argv[1:]
    if action not in('prepare','resume','status','rescue','export','mode','prepare-closed','resume-closed','export-closed')or not re.fullmatch('[a-f0-9]{32}',operation_id):
        raise RuntimeError('backup_helper_request_invalid')
    if action in('export','export-closed'):
        # The fixed checkpoint validator is Node (64 MiB heap) and inherits
        # this limit; V8 needs virtual address space beyond the reader's
        # separate 128 MiB limit. Snapshot files still stream in bounded chunks.
        resource.setrlimit(resource.RLIMIT_AS,(2147483648,2147483648))
        resource.setrlimit(resource.RLIMIT_CPU,(20,20))
        resource.setrlimit(resource.RLIMIT_CORE,(0,0))
        def expired(*_):raise RuntimeError('backup_snapshot_deadline')
        signal.signal(signal.SIGALRM,expired);signal.alarm(30)
    sys.path.insert(0,str(Path(__file__).parent))
    from maintenance_backend import Backend
    from maintenance_journal import Journal
    from maintenance_controller import Controller
    from maintenance_plan import BackupPlan
    backend=Backend()
    closed_action=action.endswith('-closed')
    if action not in('rescue','mode')and not closed_action:backend.authorize(None,mutation=False)
    journal=Journal(STATE,backend.policy['approval_sha256'],read_only=action in('status','mode'))
    try:
        if action=='mode'or closed_action:
            from frozen_backup import FrozenBackup,source_authorization
            from worker import Paths
            frozen=FrozenBackup(journal,backend,Paths())
            if action=='mode':
                observed=source_authorization(Paths())
                mode='live'if observed['source_authorization_state']=='active'else'closed'
                if mode=='closed':frozen.profile();frozen._source()
                else:
                    backend.authorize(None,mutation=False)
                    BackupPlan(Controller(journal,backend))._profile(None)
                return {'state':'backup_mode_selected','operation_id':operation_id,'mode':mode,
                  'source_authorization_state':observed['source_authorization_state'],
                  'automatic_retry':False,'full24h_proven':False}
            if action=='prepare-closed':return frozen.prepare(operation_id)
            if action=='resume-closed':return frozen.resume(operation_id)
            from backup_snapshot import stream
            target=frozen.export(operation_id);stream(target,operation_id,sys.stdout.buffer);return None
        controller=Controller(journal,backend);plan=BackupPlan(controller)
        if action=='rescue':
            from backup_rescue import Rescue
            return Rescue(controller).run(operation_id)
        plan._profile(None)
        if action=='export':
            from backup_snapshot import prepare,artifact,stream
            from recovery_data import directory
            from worker import Paths
            # A failed/blocked transport must release the journal without
            # waiting indefinitely while the house is in its backup window.
            def boundary():
                op=plan._operation(operation_id)
                if op['records'][-1]['body']['phase']!='consumer_stopped':
                    raise RuntimeError('backup_snapshot_boundary_changed')
                if plan.step(operation_id,'prepare')['state']!='backup_plan_capture_ready':
                    raise RuntimeError('backup_snapshot_boundary_unconfirmed')
            boundary()
            parent=STATE/'backup-snapshots';parent.mkdir(mode=0o700,exist_ok=True);directory(parent,0,0,0o700)
            target=parent/operation_id
            if target.exists():artifact(target,operation_id)
            else:prepare(Paths(),journal,target,operation_id,boundary)
            boundary();stream(target,operation_id,sys.stdout.buffer);return None
        if action=='prepare':
            op=controller._operation(operation_id)
            if op is None:
                controller.observe(operation_id,'begin',None,purpose='backup_snapshot')
                op=controller._operation(operation_id)
            if op is None:return {'state':'backup_plan_begin_unavailable','automatic_retry':False}
            plan.seal(operation_id,op['records'][-1]['sha256'])
        return plan.status(operation_id)if action=='status'else plan.run(operation_id,action)
    finally:journal.close()

if __name__=='__main__':
    try:
        result=main()
        if result is None:raise SystemExit(0)
        print(json.dumps(result,separators=(',',':')))
        raise SystemExit(0 if result['state']in('backup_plan_capture_ready','backup_plan_complete','backup_plan_active',
          'backup_rescue_not_required','backup_rescue_house_running_metadata_disabled',
          'backup_mode_selected','backup_closed_capture_ready','backup_closed_metadata_complete')else 1)
    except Exception:
        print('{"state":"backup_plan_unconfirmed","automatic_retry":false}');raise SystemExit(1)
