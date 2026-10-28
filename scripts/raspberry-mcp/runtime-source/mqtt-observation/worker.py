"""Fixed-path Root metadata reader. Installation/activation is separately approved."""
from pathlib import Path
from dataclasses import dataclass
import hashlib,json,os,resource,select,signal,socket,sys,time
sys.path.insert(0,str(Path(__file__).parent))
from activated_reader import from_systemd
from authorization_gate import AuthorizationGate,GateInvalid
from worker_config import load_source_policy
from source_binding import SourceVerifier,local_clock_domain
from socket_reader import PacketIntake
from handoff_ledger import HandoffLedger
from file_bridge import FileBridge
from status_writer import StatusWriter
AS_LIMIT=134217728
@dataclass(frozen=True)
class Paths:
    state:Path=Path("/var/lib/raspberry-mqtt-observation")
    runtime:Path=Path("/run/raspberry-mqtt-observation")
    report:Path=Path("/mnt/data/docker/nodered/.mqtt-source-observer-report")
    consumer:Path=Path("/mnt/data/docker/nodered/.mqtt-source-observer-consumer")
    @property
    def authorization(self):return self.state/"authorization.json"
    @property
    def source_policy(self):return self.state/"source-policy.json"
    @property
    def ledger(self):return self.state/"state.sqlite3"
    @property
    def source_socket(self):return self.runtime/"source.sock"
def boottime():return time.clock_gettime_ns(time.CLOCK_BOOTTIME)
def notify(message):
    destination=os.environ.get("NOTIFY_SOCKET")
    if not destination or destination[0]not in("/","@"):raise GateInvalid("notify_socket_missing")
    if destination.startswith("@"):destination="\0"+destination[1:]
    with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM|socket.SOCK_NONBLOCK|socket.SOCK_CLOEXEC)as channel:
        channel.sendto(message.encode("ascii"),destination)
def matching_authority(gate,approval_id):
    policy,_=gate._read()
    if policy["approval_id"]!=approval_id:raise GateInvalid("source_authorization_mismatch")
    return policy
def bootstrap_approved(paths):
    if os.geteuid()!=0:raise GateInvalid("reader_role_invalid")
    gate=AuthorizationGate(paths.runtime,paths.authorization)
    try:
        _,approval=load_source_policy(paths.source_policy)
        policy=matching_authority(gate,approval)
        if not policy["enabled"]or(policy["expires_at"]is not None and time.time()>=policy["expires_at"]):
            raise GateInvalid("bootstrap_not_authorized")
        # O_EXCL in the canonical constructor: never overwrite/reset a ledger.
        ledger=HandoffLedger(paths.ledger,create=True,clock_domain_id=local_clock_domain(),started_ns=boottime(),start_session=False)
        try:
            if ledger.body["reader_sessions"]!=0:raise GateInvalid("bootstrap_session_invalid")
        finally:ledger.close()
    finally:gate.close()
class Worker:
    def __init__(self,paths,*,reader_factory=from_systemd,notifier=notify):
        self.paths=paths;self.gate=None;self.ledger=None;self.bridge=None;self.reader=None;self.source_verifier=None
        self.notifier=notifier;self.stop=False;self.last_source_completed=None;self.last_intake="waiting"
        self.instance=hashlib.sha256(os.urandom(32)).hexdigest();self.started=boottime();self.domain=local_clock_domain()
        try:
            if os.geteuid()!=0:raise GateInvalid("reader_role_invalid")
            self.gate=AuthorizationGate(paths.runtime,paths.authorization)
            policy,self.approval_id=load_source_policy(paths.source_policy)
            matching_authority(self.gate,self.approval_id)
            self.ledger=HandoffLedger(paths.ledger,create=False,clock_domain_id=self.domain,started_ns=self.started)
            self.bridge=FileBridge(paths.report,paths.consumer,consumer_uid=1000,consumer_gid=1000)
            self.status_writer=StatusWriter(self.bridge)
            self.source_verifier=SourceVerifier(policy)
            intake=PacketIntake(self.ledger,self.source_verifier,require_sender_pidfd=True)
            self.reader=reader_factory(paths.source_socket,intake=intake)
            self.authorization=self.gate.refresh()
            self.bridge.publish(self.ledger,boottime());self.write_status()
        except BaseException:
            if self.gate is not None:
                try:self.gate._remove_marker()
                except BaseException:pass
            self.close();raise
    def write_status(self):
        source=None;state=self.ledger.body['state'];identity=self.source_verifier.sender_state()
        if (state is not None and self.last_source_completed is not None
            and self.last_intake in('accepted','duplicate')and identity!='unknown'):
            source={'epoch':str(state['epoch']),
                'instance_sha256':hashlib.sha256(state['instance'].encode('ascii')).hexdigest(),
                'wire_version':state.get('last_source_wire_version',1),
                'started_boottime_ns':None if state['started_ns']is None else str(state['started_ns']),
                'emitted_boottime_ns':None if state['last_emitted_ns']is None else str(state['last_emitted_ns']),
                'covered_before_ns':None if state.get('last_covered_before_ns')is None else str(state['last_covered_before_ns']),
                'closed':state.get('source_closed',False),'identity_state':identity}
        self.status_writer.write({"schema_version":2,"source":"fixed_mqtt_metadata_reader",
            "reader_instance_sha256":self.instance,"clock_domain_sha256":self.domain,
            "reader_started_boottime_ns":str(self.started),"reader_observed_boottime_ns":str(boottime()),
            "reader_observed_monotonic_ns":str(time.monotonic_ns()),
            "authorization_state":self.authorization["state"],
            "source_authorized":self.authorization["source_authorized"],
            "last_intake_state":self.last_intake,"last_successful_intake_completed_boottime_ns":
                None if self.last_source_completed is None else str(self.last_source_completed),
            "accepted_frames":str(self.ledger.body["accepted_frames"]),
            "reader_sessions":str(self.ledger.body["reader_sessions"]),
            "source_facts":source,
            "faults":{k:str(v)for k,v in self.ledger.body["faults"].items()},
            "full24h_proven":False,"all_event_latency_proven":False})
    def refresh_authority(self):
        self.authorization=self.gate.refresh()
        if self.authorization["source_authorized"]is True:
            try:matching_authority(self.gate,self.approval_id)
            except BaseException:
                self.gate._remove_marker();raise
    def step(self,timeout=0.1):
        if self.authorization["source_authorized"]is not True:
            time.sleep(timeout);return
        readable,_,_=select.select([self.reader.sock],[],[],timeout)
        if readable:
            for _ in range(16):
                value=self.reader.receive()
                if value is None:break
                self.last_intake=value["status"]
                if value["status"]=="accepted":self.last_source_completed=boottime()
        self.bridge.poll_ack(self.ledger)
        self.bridge.publish(self.ledger,boottime())
    def run(self):
        self.notifier("READY=1\nSTATUS=Metadata reader initialized")
        next_status=time.monotonic()
        while not self.stop:
            now=time.monotonic()
            if now>=next_status:
                self.refresh_authority()
                self.write_status();self.notifier("WATCHDOG=1");next_status=now+1
            self.step()
    def close(self):
        # Socket belongs to the manager; an ordinary reader restart preserves
        # its path/queue and the existing owner-approved authorization marker.
        for key in ["reader","source_verifier","bridge","ledger","gate"]:
            value=getattr(self,key,None)
            if value is not None:value.close();setattr(self,key,None)
def main():
    if sys.argv[1:]not in([],["bootstrap-approved"]):return 64
    worker=None
    try:
        resource.setrlimit(resource.RLIMIT_AS,(AS_LIMIT,AS_LIMIT))
        if sys.argv[1:]:
            bootstrap_approved(Paths());print('{"state":"bootstrap_created_no_reader_session"}');return 0
        worker=Worker(Paths())
        def stopping(_signum,_frame):worker.stop=True
        signal.signal(signal.SIGTERM,stopping);signal.signal(signal.SIGINT,stopping)
        worker.run();return 0
    except Exception:
        # No raw packet, exception text, path, PID or policy contents leave.
        print('{"state":"unknown","collection_error":"metadata_reader_unavailable"}');return 1
    finally:
        if worker is not None:worker.close()
if __name__=="__main__":raise SystemExit(main())
