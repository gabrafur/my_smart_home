import array,json,os,socket,struct,tempfile,unittest
from pathlib import Path
from receiver_ledger import Ledger
from source_binding import BindingUnavailable,VerifiedBinding
from socket_reader import PacketIntake,SocketReader,ReaderUnavailable
from test_protocol import frame
from protocol import MAX_FRAME_BYTES

DOMAIN='d'*64
class FakeVerifier:
    def __init__(self):self.calls=[];self.reject=False;self.domain=DOMAIN
    def verify(self,peer):
        self.calls.append(peer)
        if self.reject:raise BindingUnavailable('PRIVATE_EXCEPTION_SENTINEL')
        return VerifiedBinding('a'*64,self.domain)

class SocketTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='mqtt-intake-')
        self.root=Path(self.tmp.name)
        self.ledger=Ledger(self.root/'ledger.sqlite3',create=True,clock_domain_id=DOMAIN,started_ns=100)
        self.verifier=FakeVerifier();self.intake=PacketIntake(self.ledger,self.verifier)
        self.reader=SocketReader(self.root/'source.sock',group_gid=os.getegid(),intake=self.intake)
        self.sender=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
    def tearDown(self):
        self.sender.close();self.reader.close();self.ledger.close();self.tmp.cleanup()
    def raw(self):return json.dumps(frame()).encode()
    def send(self,data=None):
        self.sender.sendto(self.raw()if data is None else data,str(self.reader.path))
        return self.reader.receive()
    def creds(self):return (socket.SOL_SOCKET,socket.SCM_CREDENTIALS,struct.pack('3i',os.getpid(),os.geteuid(),os.getegid()))

    def test_real_kernel_credentials_reach_attestor_before_intake(self):
        self.assertEqual(self.send()['status'],'accepted')
        peer=self.verifier.calls[-1]
        self.assertEqual((peer.pid,peer.uid,peer.gid),(os.getpid(),os.geteuid(),os.getegid()))
        self.assertEqual(self.ledger.body['accepted_frames'],1)
    def test_empty_queue_is_not_a_fault(self):
        before=json.dumps(self.ledger.body)
        self.assertIsNone(self.reader.receive());self.assertEqual(json.dumps(self.ledger.body),before)
    def test_truncated_datagram_is_latched_before_attestation(self):
        self.assertEqual(self.send(b'x'*(MAX_FRAME_BYTES+1))['status'],'unknown')
        self.assertEqual(self.ledger.body['faults']['transport_truncated'],1)
        self.assertEqual(self.verifier.calls,[])
    def test_missing_or_duplicate_credentials_are_rejected(self):
        for anc in [[],[self.creds(),self.creds()]]:
            result=self.intake.packet(self.raw(),anc,0,300)
            self.assertEqual(result['status'],'unknown')
        self.assertEqual(self.ledger.body['faults']['transport_ancillary_invalid'],2)
        self.assertEqual(self.verifier.calls,[])
    def test_bad_credential_length_is_rejected_without_interpreting_data(self):
        self.intake.packet(self.raw(),[(socket.SOL_SOCKET,socket.SCM_CREDENTIALS,b'PRIVATE')],0,300)
        self.assertEqual(self.ledger.body['faults']['transport_ancillary_invalid'],1)
    def test_untrusted_pid_code_or_clock_does_not_advance_source_state(self):
        self.verifier.reject=True;self.assertEqual(self.send()['status'],'unknown')
        self.verifier.reject=False;self.verifier.domain='e'*64;self.assertEqual(self.send()['status'],'unknown')
        self.assertIsNone(self.ledger.body['state'])
        self.assertEqual(self.ledger.body['faults']['source_identity_lost'],2)
        self.assertNotIn('PRIVATE_EXCEPTION_SENTINEL',json.dumps(self.ledger.report()))
    def test_payload_self_attestation_cannot_override_failed_binding(self):
        self.verifier.reject=True;value=frame();value['source_binding_verified']=True
        self.assertEqual(self.send(json.dumps(value).encode())['status'],'unknown')
        self.assertEqual(self.ledger.body['accepted_frames'],0)
    def test_received_rights_are_closed_and_never_accepted(self):
        read_fd,write_fd=os.pipe()
        try:
            before=len(os.listdir('/proc/self/fd'))
            self.sender.sendmsg([self.raw()],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[read_fd]))],0,str(self.reader.path))
            self.assertEqual(self.reader.receive()['status'],'unknown')
            self.assertEqual(len(os.listdir('/proc/self/fd')),before)
            os.fstat(read_fd)
            self.assertEqual(self.verifier.calls,[])
        finally:os.close(read_fd);os.close(write_fd)
    def test_truncated_rights_are_also_closed_without_fd_leak(self):
        read_fd,write_fd=os.pipe()
        try:
            before=len(os.listdir('/proc/self/fd'))
            self.sender.sendmsg([self.raw()],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[read_fd]*40))],0,str(self.reader.path))
            self.assertEqual(self.reader.receive()['status'],'unknown')
            self.assertEqual(len(os.listdir('/proc/self/fd')),before)
            self.assertEqual(self.ledger.body['faults']['transport_truncated'],1)
        finally:os.close(read_fd);os.close(write_fd)
    def test_socket_mode_does_not_allow_world_writes(self):
        info=self.reader.path.lstat()
        self.assertEqual(info.st_mode&0o777,0o620);self.assertEqual(info.st_gid,os.getegid())
    def test_existing_socket_is_not_unlinked_by_second_reader(self):
        inode=self.reader.path.lstat().st_ino
        with self.assertRaisesRegex(ReaderUnavailable,'^socket_open_failed$'):
            SocketReader(self.reader.path,group_gid=os.getegid(),intake=self.intake)
        self.assertEqual(self.reader.path.lstat().st_ino,inode)
        self.assertEqual(self.send()['status'],'accepted')
    def test_cleanup_never_removes_replacement_path(self):
        path=self.reader.path;path.unlink();path.write_text('replacement')
        self.reader.close();self.assertEqual(path.read_text(),'replacement')

if __name__=='__main__':unittest.main()
