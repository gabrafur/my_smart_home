import hashlib,importlib.util,json,os,subprocess,sys,time
from pathlib import Path
STAGE=Path('/run/raspberry-event-delivery-health-20261025')
STATE=Path('/var/lib/raspberry-eva-repair-install-20261024')
INTENT=STATE/'event-delivery-health-activation-intent.json'
RECEIPT=STATE/'event-delivery-health-activation.json'
def need(ok,reason):
 if not ok:raise ValueError(reason)
def main():
 need(os.geteuid()==0 and Path(__file__).absolute()==STAGE/'activate.py' and not sys.argv[1:],'fixed_stage_required')
 src=Path('/run/raspberry-eva-repair-20261024/install.py');need(hashlib.sha256(src.read_bytes()).hexdigest()=='53295b03ad358f70e454be81eb02102bd0a075fa0e691cbfff997b8fb8967f1d','reader_changed')
 spec=importlib.util.spec_from_file_location('sealed',src);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 if RECEIPT.exists():print(base.read(RECEIPT,0o600).decode());return
 need(not INTENT.exists(),'existing_intent_requires_readonly_reconciliation')
 need(time.time()<(1792941922 + 2443945 / 10000000),'original_admission_expired')
 for target in ['/usr/local/lib/raspberry-repair-control/event_projection.mjs','/var/lib/raspberry-mcp/root/app/event_projection.mjs']:
  need(base.sha(base.read(Path(target)))=='a9f023d6525008c3116d34b1932d4d644dd9b6f358be72337a57aa08f42a7349','projection_changed')
 need(json.loads(base.read(STATE/'event-delivery-health.json',0o600))['state']=='event_delivery_health_applied','installation_unconfirmed')
 sys.path[:0]=['/usr/local/lib/raspberry-task-control','/usr/local/lib/raspberry-mcp'];import task_control as tasks;import codex_control as old;tasks.policy(old)
 with tasks.locked():
  base.idle_databases(tasks)
  trigger=Path('/mnt/data/docker/homeassistant/.daily-update-trigger');need(not[x for x in trigger.iterdir()if x.name.endswith(('-requested','-processing'))],'daily_worker_active')
  command=['/usr/bin/systemctl'];unit='raspberry-mcp-tunnel.service'
  before=subprocess.check_output(command+['show',unit,'--property=MainPID','--value'],timeout=5,text=True).strip();need(before.isdigit()and int(before)>1,'tunnel_not_running')
  base.atomic(INTENT,(json.dumps({'state':'intent_before_fixed_MCP_tunnel_restart','at':time.time(),'previous_main_pid':int(before),'unit':unit,'automatic_retry':False,'household_services_restarted':0})+'\n').encode(),0o600)
  result=subprocess.run(command+['restart',unit],capture_output=True,timeout=25)
  need(result.returncode==0,'restart_result_uncertain')
  after=subprocess.check_output(command+['show',unit,'--property=MainPID','--value'],timeout=5,text=True).strip();need(after.isdigit()and int(after)>1 and after!=before,'restart_identity_unconfirmed')
  receipt={'state':'MCP_tunnel_restart_completed_client_acceptance_pending','at':time.time(),'unit':unit,'previous_main_pid':int(before),'new_main_pid':int(after),'household_services_restarted':0,'daemon_restarted':False,'new_events':0,'new_inference':False,'subscription_changed':False,'expiry_unchanged':(1792941922 + 2443945 / 10000000),'automatic_retry':False}
  base.atomic(RECEIPT,(json.dumps(receipt,sort_keys=True)+'\n').encode(),0o600);print(json.dumps(receipt))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'state':'activation_unconfirmed','exception_kind':type(e).__name__,'automatic_retry':False,'raw_error_withheld':True}));raise SystemExit(1)
