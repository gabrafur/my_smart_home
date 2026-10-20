"""Read-only upgrades of existing tool names; existing writes unchanged."""
import importlib.util
from pathlib import Path
import operations
import maintenance_diagnostics as diagnostics
import maintenance_evidence as evidence

class EvidenceBroker(operations.Broker):
    def handle(self,name,args):
        if name in ('backup_results','log_summary','host_diagnostics'):
            return evidence.handle(name,args)
        if name in diagnostics.FIELDS:return diagnostics.handle(self,name,args)
        return super().handle(name,args)

if __name__=='__main__':
    operations.Broker=EvidenceBroker
    operations.FIELDS.update(diagnostics.FIELDS)
    operations.FIELDS.update({'backup_results':(),'log_summary':('service',)})
    operations.main()
