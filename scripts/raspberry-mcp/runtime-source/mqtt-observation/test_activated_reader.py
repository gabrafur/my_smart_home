"""Actual Unix datagrams; disposable Root fixtures only."""
from pathlib import Path
import array,os,socket,struct,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
from activated_reader import ActivatedSocketReader,from_systemd
from socket_reader import ReaderUnavailable
from source_binding import SCM_PIDFD,sender_pidfd_key
class Intake:
 def __init__(self):self.rows=[]
 def packet(self,raw,ancillary,flags,at):
  value={"raw":raw,"ancillary":ancillary,"flags":flags,"at":at};self.rows.append(value);return value
@unittest.skipUnless(os.geteuid()==0 and os.getegid()==0, "requires isolated Root ownership fixture; ordinary suite never escalates")
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix="mqtt-activated-")
  self.path=Path(self.temp.name)/"source.sock";self.path.parent.chmod(0o755)
  self.owner=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);self.owner.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
  self.owner.bind(str(self.path));os.chown(self.path,0,1883);self.path.chmod(0o620)
  self.sender=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);self.intake=Intake();self.readers=[]
 def reader(self,fd=None,path=None):
  value=ActivatedSocketReader(path or self.path,fd=self.owner.fileno()if fd is None else fd,intake=self.intake);self.readers.append(value);return value
 def tearDown(self):
  for r in self.readers:r.close()
  self.sender.close();self.owner.close();self.temp.cleanup()
 def test_actual_credentials_and_timestamp_reach_same_intake(self):
  r=self.reader();self.sender.sendto(b"synthetic",str(self.path));v=r.receive()
  self.assertEqual(v["raw"],b"synthetic");self.assertGreater(v["at"],0)
  creds=[data for level,kind,data in v["ancillary"]if level==socket.SOL_SOCKET and kind==socket.SCM_CREDENTIALS]
  self.assertEqual(struct.unpack("3i",creds[0]),(os.getpid(),0,0))
 def test_restart_preserves_socket_and_queued_data(self):
  first=self.reader();inode=self.path.stat().st_ino;first.close()
  self.sender.sendto(b"during_restart",str(self.path));second=self.reader()
  self.assertEqual(second.receive()["raw"],b"during_restart");self.assertEqual(self.path.stat().st_ino,inode)
 def test_strong_sender_option_applies_to_preexisting_manager_queue(self):
  self.intake.require_sender_pidfd=True
  self.sender.sendto(b"queued_before_reader",str(self.path))
  before=len(os.listdir('/proc/self/fd'));r=self.reader()
  value=r.receive();fds=[]
  try:
   for level,kind,data in value['ancillary']:
    if level==socket.SOL_SOCKET and kind==SCM_PIDFD:
     row=array.array('i');row.frombytes(data);fds.extend(row)
   self.assertEqual(len(fds),1);sender_pidfd_key(fds[0])
   self.assertEqual(value['raw'],b'queued_before_reader')
  finally:
   for fd in fds:os.close(fd)
  r.close();self.assertEqual(len(os.listdir('/proc/self/fd')),before)
 def test_close_does_not_close_manager_descriptor(self):
  r=self.reader();r.close();os.fstat(self.owner.fileno());self.assertTrue(self.path.exists())
 def test_nonblocking_and_cloexec(self):
  r=self.reader();self.assertIsNone(r.receive());self.assertFalse(os.get_inheritable(r.sock.fileno()))
 def test_missing_credentials_option_rejected(self):
  self.owner.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,0)
  with self.assertRaisesRegex(ReaderUnavailable,"credentials_missing"):self.reader()
 def test_wrong_socket_path_rejected(self):
  other=Path(self.temp.name)/"other.sock";s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
  try:
   s.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1);s.bind(str(other));os.chown(other,0,1883);other.chmod(0o620)
   with self.assertRaisesRegex(ReaderUnavailable,"identity_invalid"):self.reader(fd=s.fileno())
  finally:s.close()
 def test_wrong_mode_and_owner_rejected(self):
  self.path.chmod(0o666)
  with self.assertRaisesRegex(ReaderUnavailable,"path_invalid"):self.reader()
  self.path.chmod(0o620);os.chown(self.path,1000,1883)
  with self.assertRaisesRegex(ReaderUnavailable,"path_invalid"):self.reader()
 def test_writable_parent_rejected(self):
  self.path.parent.chmod(0o777)
  with self.assertRaisesRegex(ReaderUnavailable,"parent_invalid"):self.reader()
 def test_wrong_descriptor_does_not_leak_or_close_original(self):
  fd=os.open("/dev/null",os.O_RDONLY)
  try:
   before=len(os.listdir("/proc/self/fd"))
   with self.assertRaises(ReaderUnavailable):self.reader(fd=fd)
   self.assertEqual(len(os.listdir("/proc/self/fd")),before);os.fstat(fd)
  finally:os.close(fd)
 def test_connected_datagram_rejected(self):
  other=Path(self.temp.name)/"other.sock";s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
  try:
   s.bind(str(other));self.owner.connect(str(other))
   with self.assertRaisesRegex(ReaderUnavailable,"connected"):self.reader()
  finally:s.close()
 def test_environment_exactness(self):
  valid={"LISTEN_PID":str(os.getpid()),"LISTEN_FDS":"1","LISTEN_FDNAMES":"source"}
  for values in [{},{**valid,"LISTEN_PID":"0"},{**valid,"LISTEN_FDS":"2"},{**valid,"LISTEN_FDNAMES":"other"}]:
   with self.assertRaisesRegex(ReaderUnavailable,"environment_invalid"):from_systemd(self.path,intake=self.intake,environ=values)
 def test_environment_hand_off_closes_only_original_fd3(self):
  env={"LISTEN_PID":str(os.getpid()),"LISTEN_FDS":"1","LISTEN_FDNAMES":"source"};fake=object()
  with patch("activated_reader.ActivatedSocketReader",return_value=fake)as ctor,patch("activated_reader.os.close")as close:
   self.assertIs(from_systemd(self.path,intake=self.intake,environ=env),fake)
   ctor.assert_called_once_with(self.path,fd=3,intake=self.intake);close.assert_called_once_with(3)
   self.assertEqual(env,{})
if __name__=="__main__":
 assert os.getuid()==os.getgid()==0
 unittest.main()
