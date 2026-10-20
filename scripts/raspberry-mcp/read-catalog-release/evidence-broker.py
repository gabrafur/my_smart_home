"""Candidate broker: report already implemented evidence accurately; no new access."""
import operations
import maintenance_diagnostics as diagnostics
import maintenance_evidence as evidence

TOOLS=('service_health','service_versions','disk_space','backup_results','log_summary',
 'project_files','project_read','project_prepare_edit','service_prepare_restart',
 'change_apply','change_revert','maintenance_capabilities','host_diagnostics',
 'service_diagnostics','operation_status','change_validate')

class EvidenceBroker(operations.Broker):
    def handle(self,name,args):
        if name in ('backup_results','log_summary','host_diagnostics'):
            return evidence.handle(name,args)
        if name in diagnostics.FIELDS:
            result=diagnostics.handle(self,name,args)
            if name=='maintenance_capabilities':
                result['schema_version']='1.2.0'
                envelope=result['evidence'];data=envelope['data']
                envelope['source']='maintenance.capabilities.read_catalog_1_2_0'
                envelope['coverage']=['capability_report_not_runtime_health','existing_sixteen_tools','no_new_write_scope']
                data['pending']=[item for item in data['pending'] if item!='sanitized_log_pagination']
                data['tool_names']=list(TOOLS)
                data['implemented']={
                  'sanitized_log_pagination':{'tool':'log_summary','max_lines':1000,'max_bytes':262144,'page_size':5,'requires_stable_window_and_digest':True,'unsupported_patterns':'omitted'},
                  'sanitized_icloud_stack':{'tool':'log_summary','scope':'reviewed_core_locations','exception_keys':'omitted'},
                  'backup_reasons_and_lock_counts':{'tool':'backup_results','coverage':'producer_result_and_instantaneous_lock_metadata'},
                }
                data['catalog_limits']={'homeassistant':'existing_dashboards_and_eight_fixed_read_only_files','icloud_adapter':'seven_fixed_files_read_only','backup_worker':'four_fixed_scripts_read_only','new_source_edits':'not_enabled','read_only_paths':sorted(operations.READ_ONLY_PATHS),'read_only_file_count':12,'categories':['docs','nodered','homeassistant','maintenance']}
                data['validation_limits']={'change_validate':'javascript_syntax_only','deployment':'not_implemented','functional_readiness':'not_implemented'}
            return result
        return super().handle(name,args)

if __name__=='__main__':
    operations.Broker=EvidenceBroker
    operations.FIELDS.update(diagnostics.FIELDS)
    operations.FIELDS.update({'backup_results':(),'log_summary':('service',)})
    operations.main()
