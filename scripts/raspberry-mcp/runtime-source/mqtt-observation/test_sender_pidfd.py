"""Owned AF_UNIX/task lifecycle tests; no broker or residential data.

The stub below replaces executable/cgroup attestation only. Kernel credentials,
pidfd delivery, task identity, exit/reap, descriptor ownership and queueing are
real. Full broker file attestation remains a separate native integration proof.
"""
import array,json,os,select,signal,socket,struct,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from receiver_ledger import Ledger
from socket_reader import PacketIntake,SocketReader
from source_binding import (BindingUnavailable,Peer,ProcHandle,SCM_PIDFD,
    SO_PASSPIDFD,SourceVerifier,VerifiedBinding,local_clock_domain,
    require_sender_pidfd_support,sender_pidfd_key,sender_pidfd_pid)
from test_protocol import frame
from test_source_binding import policy


def supported():
    try:
        require_sender_pidfd_support()
        with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)as sock:
            sock.setsockopt(socket.SOL_SOCKET,SO_PASSPIDFD,1)
        return True
    except(OSError,AttributeError,BindingUnavailable):return False


@unittest.skipUnless(supported(),'requires 64-bit Linux pidfs and SO_PASSPIDFD')
class SenderTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mqtt-pidfd-')
        self.root=Path(self.temp.name);self.children={}
        self.domain=local_clock_domain();self.calls=[]
        self.verifier=SourceVerifier(policy(peer_uid=os.geteuid(),peer_gid=os.getegid()))
        self.stub=patch.object(self.verifier,'_verify_live',side_effect=self.live)
        self.stub.start()
        self.ledger=Ledger(self.root/'ledger.sqlite3',create=True,clock_domain_id=self.domain,started_ns=100)
        self.intake=PacketIntake(self.ledger,self.verifier,require_sender_pidfd=True)
        self.reader=SocketReader(self.root/'source.sock',group_gid=os.getegid(),intake=self.intake)
        self.sender=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)

    def tearDown(self):
        for pid,fd in list(self.children.items()):
            os.close(fd)
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
            os.waitpid(pid,0)
        self.sender.close();self.reader.close();self.stub.stop()
        self.ledger.close();self.temp.cleanup()

    def live(self,peer,key):
        # Exercise the real kernel-task comparison used before proc code reads.
        proc=ProcHandle(peer.pid)
        try:self.assertEqual(sender_pidfd_key(proc.pidfd),key);proc.alive()
        finally:proc.close()
        self.calls.append(peer)
        return VerifiedBinding('a'*64,self.domain)

    def raw(self,**kwargs):return json.dumps(frame(**kwargs)).encode()

    def child(self):
        read_fd,write_fd=os.pipe2(os.O_CLOEXEC)
        pid=os.fork()
        if pid==0:
            try:
                os.close(write_fd)
                with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)as sender:
                    while True:
                        command=os.read(read_fd,1)
                        if command==b'a':sender.sendto(self.raw(),str(self.reader.path))
                        elif command==b'b':sender.sendto(self.raw(seq=2),str(self.reader.path))
                        elif command==b'x':break
                        else:os._exit(2)
                os._exit(0)
            except BaseException:os._exit(3)
        os.close(read_fd);self.children[pid]=write_fd
        return pid

    def command(self,pid,command):os.write(self.children[pid],command)

    def receive(self):
        self.assertTrue(select.select([self.reader.sock],[],[],3)[0],'owned sender timed out')
        return self.reader.receive()

    def reap(self,pid):
        self.command(pid,b'x');os.close(self.children.pop(pid))
        # Deadline prevents a broken fixture from hanging the canonical suite.
        fd=os.pidfd_open(pid,0)
        try:
            if not select.select([fd],[],[],3)[0]:
                os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)
                self.fail('owned sender did not exit')
            self.assertEqual(os.waitpid(pid,0)[1],0)
        finally:os.close(fd)

    def test_real_live_sender_is_bound_to_kernel_task_and_only_one_fd_retained(self):
        before=len(os.listdir('/proc/self/fd'))
        for _ in range(4):
            self.sender.sendto(self.raw(),str(self.reader.path));self.receive()
            self.assertEqual(len(os.listdir('/proc/self/fd')),before+1)
        self.assertEqual(len(self.calls),4)  # Live tasks are re-attested each time.
        self.assertTrue(self.verifier.sender_binding.kernel_sender_bound)
        self.assertEqual(self.verifier.sender_state(),'verified_live')
        self.assertFalse(self.verifier.sender_binding.retained_after_exit)
        self.reader.close();self.assertEqual(len(os.listdir('/proc/self/fd')),before-1)
        self.assertEqual(self.verifier.sender_state(),'unknown')

    def test_queued_frame_after_exit_and_reap_reuses_only_same_verified_kernel_task(self):
        pid=self.child();self.command(pid,b'a')
        self.assertEqual(self.receive()['status'],'accepted')
        key=self.verifier.sender_key;held=self.verifier.sender_fd
        self.command(pid,b'b');self.reap(pid)
        self.assertEqual(sender_pidfd_pid(held),-1)
        self.assertEqual(self.verifier.sender_state(),'verified_exited')
        self.assertEqual(sender_pidfd_key(held),key)
        self.assertEqual(self.receive()['status'],'accepted')
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.ledger.body['accepted_frames'],2)

    def test_dead_sender_with_cold_cache_is_unknown_and_no_descriptor_leaks(self):
        pid=self.child();self.command(pid,b'a');self.reap(pid)
        before=len(os.listdir('/proc/self/fd'))
        self.assertEqual(self.receive()['status'],'unknown')
        self.assertEqual(len(os.listdir('/proc/self/fd')),before)
        self.assertIsNone(self.verifier.sender_fd)
        self.assertEqual(self.calls,[])

    def test_different_task_cannot_use_previous_dead_sender_binding(self):
        first=self.child();self.command(first,b'a');self.receive();self.reap(first)
        second=self.child();self.command(second,b'a');self.reap(second)
        self.assertEqual(self.receive()['status'],'unknown')
        self.assertEqual(len(self.calls),1)

    def test_replacing_live_sender_closes_previous_retained_descriptor(self):
        first=self.child();self.command(first,b'a');self.receive()
        old_fd=self.verifier.sender_fd;old_key=self.verifier.sender_key
        second=self.child();self.command(second,b'a');self.receive()
        self.assertNotEqual(self.verifier.sender_key,old_key)
        with self.assertRaises(OSError):os.fstat(old_fd)
        self.reap(first);self.reap(second)

    def test_clock_change_rejects_retained_binding(self):
        pid=self.child();self.command(pid,b'a');self.receive()
        self.command(pid,b'b');self.reap(pid)
        with patch('source_binding.local_clock_domain',return_value='f'*64):
            self.assertEqual(self.receive()['status'],'unknown')

    def test_wrong_peer_and_other_live_task_descriptor_are_rejected(self):
        fd=os.pidfd_open(os.getpid(),0)
        try:
            for peer in [Peer(os.getpid()+1,os.geteuid(),os.getegid()),
                         Peer(os.getpid(),os.geteuid()+1,os.getegid())]:
                with self.assertRaises(BindingUnavailable):self.verifier.verify_sender(peer,fd)
            self.assertEqual(self.calls,[])
        finally:os.close(fd)

    def test_non_pidfs_and_inheritable_descriptors_fail_closed(self):
        fd=os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC)
        try:
            with self.assertRaises(BindingUnavailable):sender_pidfd_key(fd)
        finally:os.close(fd)
        fd=os.pidfd_open(os.getpid(),0)
        try:
            os.set_inheritable(fd,True)
            with self.assertRaises(BindingUnavailable):sender_pidfd_key(fd)
        finally:os.close(fd)

    def test_rights_and_sender_pidfd_closed_even_when_ancillary_is_truncated(self):
        fd=os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC)
        try:
            for count in [1,40]:
                before=len(os.listdir('/proc/self/fd'))
                self.sender.sendmsg([self.raw()],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,
                    array.array('i',[fd]*count))],0,str(self.reader.path))
                self.assertEqual(self.receive()['status'],'unknown')
                self.assertEqual(len(os.listdir('/proc/self/fd')),before)
            self.assertEqual(self.calls,[])
        finally:os.close(fd)

    def test_missing_or_duplicate_sender_descriptor_is_rejected_and_closed(self):
        creds=(socket.SOL_SOCKET,socket.SCM_CREDENTIALS,
            struct.pack('3i',os.getpid(),os.geteuid(),os.getegid()))
        self.assertEqual(self.intake.packet(self.raw(),[creds],0,300)['status'],'unknown')
        one=os.pidfd_open(os.getpid(),0);two=os.dup(one)
        ancillary=[creds,(socket.SOL_SOCKET,SCM_PIDFD,array.array('i',[one,two]).tobytes())]
        self.assertEqual(self.intake.packet(self.raw(),ancillary,0,300)['status'],'unknown')
        for fd in [one,two]:
            with self.assertRaises(OSError):os.fstat(fd)
        self.assertEqual(self.calls,[])

    def test_failed_live_reverification_does_not_fall_back_to_cache(self):
        self.sender.sendto(self.raw(),str(self.reader.path));self.receive()
        with patch.object(self.verifier,'_verify_live',side_effect=BindingUnavailable('changed')):
            self.sender.sendto(self.raw(seq=2),str(self.reader.path))
            self.assertEqual(self.receive()['status'],'unknown')

    def test_observed_identity_failure_invalidates_later_exited_sender_cache(self):
        pid=self.child();self.command(pid,b'a');self.receive()
        with patch.object(self.verifier,'_verify_live',side_effect=BindingUnavailable('changed')):
            self.command(pid,b'b');self.assertEqual(self.receive()['status'],'unknown')
        self.assertIsNone(self.verifier.sender_fd)
        self.command(pid,b'b');self.reap(pid)
        self.assertEqual(self.receive()['status'],'unknown')
        self.assertEqual(self.ledger.body['accepted_frames'],1)

    def test_real_executable_verifier_still_rejects_python_and_retains_nothing(self):
        verifier=SourceVerifier(policy(peer_uid=os.geteuid(),peer_gid=os.getegid()))
        fd=os.pidfd_open(os.getpid(),0)
        try:
            with self.assertRaisesRegex(BindingUnavailable,'^source_process_invalid$'):
                verifier.verify_sender(Peer(os.getpid(),os.geteuid(),os.getegid()),fd)
            self.assertIsNone(verifier.sender_fd)
        finally:os.close(fd);verifier.close()

    def test_kernel_task_mismatch_is_rejected_before_proc_metadata(self):
        verifier=SourceVerifier(policy(peer_uid=os.geteuid(),peer_gid=os.getegid()))
        with patch('source_binding.sender_pidfd_key',return_value=(-1,-1)):
            with self.assertRaisesRegex(BindingUnavailable,'^sender_pidfd_process_changed$'):
                verifier._verify_live(Peer(os.getpid(),os.geteuid(),os.getegid()),(0,0))

    def test_unsupported_pidfs_has_no_weak_production_fallback(self):
        with patch('socket_reader.require_sender_pidfd_support',side_effect=BindingUnavailable('unsupported')):
            with self.assertRaises(BindingUnavailable):
                PacketIntake(self.ledger,self.verifier,require_sender_pidfd=True)


if __name__=='__main__':unittest.main()
