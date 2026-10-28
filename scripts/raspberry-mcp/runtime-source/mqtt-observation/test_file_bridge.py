import copy,hashlib,json,os,stat,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from file_bridge import FileBridge,BridgeUnavailable
from handoff_ledger import HandoffLedger
from receiver_ledger import encode
from test_protocol import frame,event

DOMAIN='d'*64
class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='mqtt-file-bridge-');self.root=Path(self.tmp.name)
        self.reports=self.root/'reports';self.acks=self.root/'acks'
        self.reports.mkdir();self.reports.chmod(0o750)
        self.acks.mkdir();self.acks.chmod(0o700)
        self.ledger=HandoffLedger(self.root/'state.sqlite3',create=True,clock_domain_id=DOMAIN,started_ns=250)
        self.ledger.frame(json.dumps(frame()).encode(),300,source_binding_verified=True)
        self.now=600
        self.bridge=FileBridge(self.reports,self.acks,consumer_uid=os.geteuid(),consumer_gid=os.getegid(),clock_ns=lambda:self.now)
    def tearDown(self):
        self.bridge.close();self.ledger.close();self.tmp.cleanup()
    def publish(self,at=400):return self.bridge.publish(self.ledger,at)['envelope']
    def ack_for(self,envelope):
        packet=envelope['body']['packet']
        return dict(schema_version=1,bucket_id=packet['body']['bucket_id'],sha256=packet['sha256'])
    def write_ack(self,value,raw=None):
        temp=self.acks/'candidate.tmp'
        with temp.open('wb')as f:
            f.write(raw if raw is not None else encode(value).encode());f.flush();os.fsync(f.fileno())
        temp.chmod(0o600);os.replace(temp,self.acks/'ack.json')
    def event(self):
        self.assertEqual(self.ledger.frame(json.dumps(frame(2,1,[event()])).encode(),350,source_binding_verified=True)['status'],'accepted')

    def test_round_trip_proves_fixed_packet_identity_and_exports_receipt(self):
        self.event();envelope=self.publish()
        stored=json.loads((self.reports/'report.json').read_text())
        self.assertEqual(stored,envelope);self.assertEqual(stored['sha256'],hashlib.sha256(encode(stored['body']).encode()).hexdigest())
        self.write_ack(self.ack_for(envelope));result=self.bridge.poll_ack(self.ledger)
        self.assertEqual(result['status'],'accepted')
        self.assertEqual(result['receipt']['source_to_ack']['publish_in']['upper_ns'],'450')
        done=self.publish(700)
        self.assertIsNone(done['body']['packet']);self.assertEqual(done['body']['acked_buckets'],'1')
        self.assertEqual(done['body']['acked_counts']['stats']['publish_in']['observed'],'1')
        self.assertEqual(done['body']['last_ack'],result['receipt'])
        info=(self.reports/'report.json').stat()
        self.assertEqual(stat.S_IMODE(info.st_mode),0o640)
        self.assertEqual(info.st_gid,os.getegid())

    def test_unchanged_report_does_not_rewrite_inode_or_consume_revision(self):
        first=self.publish();before=(self.reports/'report.json').stat();revision=self.ledger.body['revision']
        second=self.bridge.publish(self.ledger,500);after=(self.reports/'report.json').stat()
        self.assertFalse(second['written']);self.assertEqual(first,second['envelope'])
        self.assertEqual((before.st_ino,before.st_mtime_ns),(after.st_ino,after.st_mtime_ns))
        self.assertEqual(self.ledger.body['revision'],revision)

    def test_missing_ack_is_expected_and_does_not_change_any_counters(self):
        before=copy.deepcopy(self.ledger.body)
        self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'absent');self.assertEqual(self.ledger.body,before)

    def test_stable_invalid_ack_is_latched_once_without_raw_content(self):
        env=self.publish();value=self.ack_for(env);value['private']='PRIVATE_ACK_CANARY'
        self.write_ack(value)
        self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'rejected')
        self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'unchanged')
        self.assertEqual(self.ledger.body['handoff']['ack_rejections'],1)
        self.assertEqual(self.publish(700)['body']['packet'],env['body']['packet'])
        self.assertNotIn('PRIVATE_ACK_CANARY',json.dumps(self.ledger.report()))

    def test_duplicate_json_keys_do_not_override_a_conflicting_digest(self):
        env=self.publish();ack=self.ack_for(env)
        raw=('{"bucket_id":"'+ack['bucket_id']+'","schema_version":1,"sha256":"'+'f'*64+'","sha256":"'+ack['sha256']+'"}').encode()
        self.write_ack(None,raw=raw)
        self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'rejected')
        self.assertEqual(self.ledger.body['handoff']['acked_buckets'],0)

    def test_conflicting_digest_cannot_release_frozen_bucket(self):
        env=self.publish();value=self.ack_for(env);value['sha256']='f'*64;self.write_ack(value)
        self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'rejected')
        self.assertEqual(self.publish(700)['body']['packet'],env['body']['packet'])

    def test_shared_ack_mode_is_rejected_before_content_is_opened(self):
        env=self.publish();self.write_ack(self.ack_for(env));(self.acks/'ack.json').chmod(0o640)
        with patch('file_bridge.os.open',wraps=os.open)as opened:
            self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'rejected')
            opened.assert_not_called()

    def test_symlink_ack_is_not_followed_or_read(self):
        self.publish();target=self.root/'private';target.write_bytes(b'PRIVATE_CANARY')
        (self.acks/'ack.json').symlink_to(target)
        with patch('file_bridge.os.open',wraps=os.open)as opened:
            self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'rejected');opened.assert_not_called()
        self.assertEqual(target.read_bytes(),b'PRIVATE_CANARY')

    def test_hardlinked_ack_is_rejected_without_content_read(self):
        self.publish();target=self.root/'private';target.write_bytes(b'PRIVATE_CANARY');target.chmod(0o600)
        os.link(target,self.acks/'ack.json')
        with patch('file_bridge.os.open',wraps=os.open)as opened:
            self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'rejected');opened.assert_not_called()

    def test_fifo_ack_cannot_block_reader(self):
        self.publish();os.mkfifo(self.acks/'ack.json',0o600)
        self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'rejected')

    def test_atomic_ack_replacement_during_read_is_retried_without_false_rejection(self):
        env=self.publish();self.write_ack(self.ack_for(env));real_open=os.open;changed=False
        def racing(path,*args,**kwargs):
            nonlocal changed
            if path=='ack.json'and not changed:
                changed=True;self.write_ack(self.ack_for(env))
            return real_open(path,*args,**kwargs)
        with patch('file_bridge.os.open',side_effect=racing):
            self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'changed_retry')
        self.assertEqual(self.ledger.body['handoff']['ack_rejections'],0)
        self.assertEqual(self.ledger.body['handoff']['acked_buckets'],0)
        self.assertEqual(self.bridge.poll_ack(self.ledger)['status'],'accepted')

    def test_report_symlink_is_never_overwritten_or_followed(self):
        target=self.root/'target';target.write_bytes(b'PRIVATE_CANARY')
        (self.reports/'report.json').symlink_to(target)
        with self.assertRaisesRegex(BridgeUnavailable,'^report_file_unsafe$'):self.publish()
        self.assertEqual(target.read_bytes(),b'PRIVATE_CANARY')
        self.assertTrue((self.reports/'report.json').is_symlink())
        self.assertEqual(self.ledger.body['handoff']['acked_buckets'],0)

    def test_pre_rename_fsync_failure_preserves_previous_report_and_cleans_temp(self):
        env=self.publish();self.write_ack(self.ack_for(env));self.bridge.poll_ack(self.ledger)
        old=(self.reports/'report.json').read_bytes()
        with patch('file_bridge.os.fsync',side_effect=OSError('PRIVATE_EXCEPTION_CANARY')):
            with self.assertRaisesRegex(BridgeUnavailable,'^report_write_failed$'):self.publish(700)
        self.assertEqual((self.reports/'report.json').read_bytes(),old)
        self.assertEqual([x.name for x in self.reports.iterdir()],['report.json'])
        self.assertIsNone(self.publish(750)['body']['packet'])

    def test_directory_fsync_failure_after_rename_remains_explicit_and_is_reconciled(self):
        env=self.publish();self.write_ack(self.ack_for(env));self.bridge.poll_ack(self.ledger)
        real_sync=os.fsync
        def directory_failure(fd):
            if fd==self.bridge.report_fd:raise OSError('PRIVATE_EXCEPTION_CANARY')
            return real_sync(fd)
        with patch('file_bridge.os.fsync',side_effect=directory_failure):
            with self.assertRaisesRegex(BridgeUnavailable,'^report_write_failed$'):self.publish(700)
        self.assertIsNone(json.loads((self.reports/'report.json').read_text())['body']['packet'])
        with patch('file_bridge.os.fsync',wraps=os.fsync)as synced:
            result=self.bridge.publish(self.ledger,750)
            self.assertFalse(result['written']);synced.assert_called_once_with(self.bridge.report_fd)

    def test_parent_path_replacement_is_detected_before_writing_any_report(self):
        self.reports.rename(self.root/'old-reports');self.reports.mkdir();self.reports.chmod(0o750)
        with self.assertRaisesRegex(BridgeUnavailable,'^bridge_parent_changed$'):self.publish()
        self.assertEqual(list(self.reports.iterdir()),[])
        self.assertEqual(list((self.root/'old-reports').iterdir()),[])

    def test_unsafe_parent_permissions_are_rejected(self):
        self.bridge.close();self.acks.chmod(0o750)
        with self.assertRaisesRegex(BridgeUnavailable,'^bridge_parent_unsafe$'):
            FileBridge(self.reports,self.acks,consumer_uid=os.geteuid(),consumer_gid=os.getegid())

if __name__=='__main__':unittest.main()
