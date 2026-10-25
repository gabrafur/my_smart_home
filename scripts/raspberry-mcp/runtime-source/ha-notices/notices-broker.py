"""Compose the installed broker; no existing write permissions are changed."""
import importlib.util
from pathlib import Path
import sys

sys.path.insert(0,'/usr/local/lib/raspberry-mcp')
import operations
import maintenance_diagnostics as diagnostics

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result

legacy=module('notice_legacy',Path('/usr/local/lib/raspberry-procmon/proactive-broker.py'))
reader=module('notice_reader',Path(__file__).with_name('notification_reader.py'))

class Broker(legacy.Broker):
    def handle(self,name,args):
        if name=='ha_notifications':
            return reader.evidence(args)
        result=super().handle(name,args)
        if name=='maintenance_capabilities':
            data=result['evidence']['data']
            data['tool_names']=[*data['tool_names'],'ha_notifications']
            data['listed_tool_count']=len(data['tool_names'])
            data['ha_notification_observer']={'read_only':True,'sanitized_snapshot_only':True,
                'events_discovery_only':True,'events_subscription_enabled':False}
        return result

if __name__=='__main__':
    operations.Broker=Broker
    operations.FIELDS.update(diagnostics.FIELDS)
    operations.FIELDS.update({'backup_results':(),'log_summary':('service',),
        'operation_submit':('operation','idempotency_key','expected_revision','target_operation_id'),
        'ha_notifications':('offset','expected_digest','notification_id')})
    operations.main()
