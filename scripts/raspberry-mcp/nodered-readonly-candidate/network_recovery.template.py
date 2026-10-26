"""Minimal fixed Node-RED return-path correction; specific network approval."""
from pathlib import Path
import hashlib,importlib.util,json,os,stat,subprocess,sys,time
STAGE=Path('/__OPERATOR_STAGE__/nodered-readonly');STATE=Path('/__OPERATOR_STATE__/nodered-network-recovery');BUNDLE=STATE/'bundle'
if Path(__file__)==BUNDLE/'apply.py':STAGE=BUNDLE
PIN='0000000000000000000000000000000000000000000000000000000000000000';EXP=0
TARGETS={'collector.cjs':Path('/usr/local/lib/raspberry-nodered-diagnostics/collector.cjs'),'unit.service':Path('/etc/systemd/system/raspberry-nodered-diagnostics.service'),'policy.json':Path('/usr/local/lib/raspberry-repair-control/policy.json')}
def sha(b):return hashlib.sha256(b).hexdigest()
def need(v,r):
 if not v:raise ValueError(r)
def run(args):
 r=subprocess.run(args,capture_output=True,timeout=8);need(r.returncode==0,'fixed_command_unconfirmed');return r.stdout
def main():
 need(os.geteuid()==0 and time.time()+60<EXP and Path(__file__)==STAGE/'apply.py'and sys.argv[1:]in(['apply-approved'],['rollback']),'fixed_valid_entrypoint_required');raw=(STAGE/'MANIFEST.json').read_bytes();need(sha(raw)==PIN,'manifest_changed');m=json.loads(raw);need(m['additional_return_peer']=='__OPERATOR_RETURN_PEER_CIDR__'and m['HTTP_destination_unchanged']=='__OPERATOR_HTTP_DESTINATION__'and set(m['targets'])==set(TARGETS),'scope_changed')
 p=STAGE/'helpers.py';need(sha(p.read_bytes())=='0000000000000000000000000000000000000000000000000000000000000000','helper_changed');spec=importlib.util.spec_from_file_location('sealed_network_helpers',p);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);tasks=h.chains()
 with h.locks(tasks):
  if sys.argv[1:] == ['rollback']:
   need(not (STATE/'rollback-intent.json').exists(),'rollback_requires_reconciliation');restore={}
   for name,path in TARGETS.items():
    need(sha(h.read(path))==m['targets'][name]['after'],'unknown_current_sources');restore[name]=h.read(STATE/(name+'.before'),0o600);need(sha(restore[name])==m['targets'][name]['before'],'backup_changed')
   h.atomic(STATE/'rollback-intent.json',h.raw({'at':time.time(),'automatic_retry':False}),0o600)
   run(['/usr/bin/systemctl','stop','raspberry-nodered-diagnostics.service'])
   for name,path in TARGETS.items():h.atomic(path,restore[name])
   h.chains();run(['/usr/bin/systemctl','daemon-reload']);print(json.dumps({'state':'previous_network_profile_restored_no_household_restart','automatic_retry':False}));return
  need(not STATE.exists(),'recovery_intent_requires_reconciliation');need(not os.path.lexists('/var/lib/raspberry-admin-executor/revoked')and not os.path.lexists('/var/lib/raspberry-nodered-diagnostics/revoked'),'revoked');before={};after={}
  for name,path in TARGETS.items():before[name]=h.read(path);after[name]=h.read(STAGE/name);need(sha(before[name])==m['targets'][name]['before']and sha(after[name])==m['targets'][name]['after'],'source_baseline_changed')
  # Exact current container peer only, not a bridge prefix or new HTTP target.
  peers=run(['/usr/bin/docker','inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}','nodered']).decode().strip().split();need(peers==['__OPERATOR_RETURN_PEER_IP__'],'NodeRED_peer_changed_requires_review')
  status=run(['/usr/bin/systemctl','show','raspberry-nodered-diagnostics.service','--property=ActiveState']).decode().strip();need(status in('ActiveState=inactive','ActiveState=failed'),'active_diagnostic_requires_reconciliation')
  h.directory(STATE,0o700);h.directory(BUNDLE,0o700)
  for name in ['MANIFEST.json','apply.py','helpers.py',*TARGETS]:h.atomic(BUNDLE/name,h.read(STAGE/name))
  for name,b in before.items():h.atomic(STATE/(name+'.before'),b,0o600)
  h.atomic(STATE/'intent.json',h.raw({'state':'intent_before_network_return_peer_correction','at':time.time(),'manifest_sha256':PIN,'new_external_HTTP_destinations':0,'same_approved_component':'nodered','automatic_retry':False}),0o600)
  for name,path in TARGETS.items():need(sha(h.read(path))==m['targets'][name]['before'],'changed_during_recovery');h.atomic(path,after[name])
  h.chains();run(['/usr/bin/systemctl','daemon-reload']);h.atomic(STATE/'receipt.json',h.raw({'state':'minimal_return_peer_and_total_deadline_applied_actual_MCP_pending','at':time.time(),'manifest_sha256':PIN,'household_restarts':0,'unit_restarts':0,'automatic_retry':False}),0o600);print(json.dumps({'state':'minimal_network_correction_applied','actual_MCP_acceptance_pending':True,'household_restarts':0,'automatic_retry':False}))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'unconfirmed','exception_class':type(e).__name__,'reason':str(e)if type(e)is ValueError else'withheld','automatic_retry':False}));raise SystemExit(1)
