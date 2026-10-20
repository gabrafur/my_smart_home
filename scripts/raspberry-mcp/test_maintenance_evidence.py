import datetime as dt
import json
from pathlib import Path
import tempfile
import time
import unittest
import sys
from unittest.mock import patch
import maintenance_evidence as e

class EvidenceTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name)
  (self.root/'homeassistant/.git-backup-trigger').mkdir(parents=True)
  (self.root/'homeassistant/.daily-update-trigger').mkdir()
  self.now=e.timestamp('2026-10-19T14:00:00Z')
 def test_backup_reason_is_projected(self):
  path=self.root/'result';path.write_text('status=deferred\nreason=maintenance_busy\nfinished_at=2026-10-19T13:59:00Z\nsecret=PRIVATE\nrequest_id=private-request\n')
  row=e.result_file(path,'fixture',self.now)
  self.assertEqual(row['data']['reason'],'maintenance_busy');self.assertEqual(row['age_seconds'],60)
  self.assertNotIn('PRIVATE',json.dumps(row));self.assertNotIn('private-request',json.dumps(row))
 def test_stale_failure_remains_reported(self):
  path=self.root/'result';path.write_text('status=failed finished_at=2026-10-15T04:08:13Z exit_code=1')
  row=e.result_file(path,'fixture',self.now)
  self.assertEqual(row['state'],'stale');self.assertEqual(row['data']['status'],'failed')
 def test_missing_is_not_failure(self):
  row=e.result_file(self.root/'missing','fixture')
  self.assertEqual(row['data']['status'],'unknown');self.assertEqual(row['collection_error'],'source_missing')
 def test_unknown_reason_never_leaks(self):
  path=self.root/'result';path.write_text('status=failed reason=private_person_name')
  self.assertNotIn('private_person',json.dumps(e.result_file(path,'fixture')))
 def test_integrity_not_invented(self):
  row=e.backups(self.root)['data']['offsite']
  self.assertIsNone(row['integrity']['verified']);self.assertIsNone(row['restoration']['verified'])
 def test_queue_presence_and_age(self):
  path=self.root/'request';path.write_text('private-id')
  row=e.queue(path,'fixture')['data'];self.assertTrue(row['present']);self.assertNotIn('private-id',json.dumps(row))
 def test_queue_symlink_rejected(self):
  path=self.root/'request';path.symlink_to('/etc/passwd')
  row=e.queue(path,'fixture');self.assertIsNone(row['data'])
 def test_last_success_exact_signature_only(self):
  synthetic_time='2026-10-18T10:00:00-03:00'
  (self.root/'.git-backup.log').write_text('['+synthetic_time+'] backup finished: pushed abcdef123\nSECRET\n')
  row=e.git_last_success(self.root)
  self.assertEqual(row['data']['kind'],'pushed');self.assertNotIn('abcdef123',json.dumps(row))
 def test_no_success_means_unknown(self):
  (self.root/'.git-backup.log').write_text('success not a proof')
  self.assertIsNone(e.git_last_success(self.root)['data'])
 def test_lock_is_metadata_only(self):
  (self.root/'.daily-maintenance.lock').touch()
  row=e.locks(self.root)[0];self.assertEqual(row['data']['lock'],'maintenance')
 def test_waiters_are_not_holders(self):
  import os
  path=self.root/'lock';path.touch();st=path.stat()
  key=f'{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}:{st.st_ino}'
  self.assertEqual(e.lock_counts(f'1: -> FLOCK ADVISORY WRITE 123 {key} 0 EOF',st),(0,1))
  self.assertEqual(e.lock_counts(f'1: FLOCK ADVISORY WRITE 123 {key} 0 EOF\n1: -> FLOCK ADVISORY WRITE 456 {key} 0 EOF',st),(1,1))
 def test_lock_other_inode_ignored(self):
  path=self.root/'lock';path.touch()
  self.assertEqual(e.lock_counts('1: FLOCK ADVISORY WRITE 123 00:00:0 0 EOF',path.stat()),(0,0))
 def trace(self,key='PRIVATE_PERSON_ID',extra=''):
  lines=['Traceback (most recent call last):',
   '  File "/usr/src/homeassistant/homeassistant/components/icloud/account.py", line 214, in update_devices',
   '  File "/usr/src/homeassistant/homeassistant/components/icloud/account.py", line 413, in __init__',
   extra,f"KeyError: '{key}'"]
  return '\n'.join('2026-10-19T13:59:00Z '+line for line in lines)
 def test_icloud_stack_explains_error_without_private_key(self):
  raw=self.trace(extra='secret=PRIVATE_VALUE location=PRIVATE_LOCATION')
  row=e.summarize_logs('homeassistant',raw,self.now-3600,self.now)['events'][0]
  self.assertEqual(row['category'],'icloud_device_update_missing_key')
  self.assertEqual(len(row['representative_stack']),2)
  self.assertNotIn('PRIVATE',json.dumps(row));self.assertNotIn('secret=',json.dumps(row))
 def test_unreviewed_stack_location_omitted(self):
  row=e.summarize_logs('homeassistant',self.trace(extra='  File "/private/PRIVATE.py", line 3, in PRIVATE'),self.now-3600,self.now)
  self.assertNotIn('PRIVATE',json.dumps(row))
 def test_missing_traceback_does_not_reuse_previous_stack(self):
  raw=self.trace()+'\n2026-10-19T13:59:01Z KeyError: PRIVATE\n'
  events=e.summarize_logs('homeassistant',raw,self.now-3600,self.now)['events']
  self.assertEqual(len(events),2)
  self.assertNotIn('representative_stack',next(x for x in events if x['category']=='missing_field'))
 def test_stack_expires(self):
  raw=self.trace(extra='\n'.join('2026-10-19T13:59:00Z neutral' for _ in range(110)))
  row=e.summarize_logs('homeassistant',raw,self.now-3600,self.now)['events'][0]
  self.assertEqual(row['category'],'missing_field');self.assertNotIn('representative_stack',row)
 def test_sensitive_log_payload_never_copied(self):
  raw='2026-10-19T13:59:00Z ERROR [homeassistant.components.websocket_api.http.connection] Unexpected exception PERSON token=SECRET calendar=PRIVATE\n2026-10-19T13:59:01Z KeyError: \'PRIVATE_EVENT\'\n'
  row=e.summarize_logs('homeassistant',raw,self.now-3600,self.now)
  text=json.dumps(row)
  for forbidden in ('PERSON','SECRET','PRIVATE','EVENT'):self.assertNotIn(forbidden,text)
  self.assertEqual(row['events'][1]['message'],'KeyError: [chave omitida]')
 def test_ipp_error_template(self):
  synthetic_address='192.168.0.3'  # PRIVACY_TEST_FIXTURE: synthetic address; no network call
  raw='2026-10-19T13:59:00Z ERROR [homeassistant.components.ipp.coordinator] Error fetching PERSONAL_PRINTER data: Invalid response: Timeout connecting to '+synthetic_address+'\n'
  row=e.summarize_logs('homeassistant',raw,self.now-3600,self.now)
  self.assertEqual(row['events'][0]['category'],'ipp_timeout')
  self.assertNotIn('192.168',json.dumps(row));self.assertNotIn('PERSONAL',json.dumps(row))
 def test_unrecognized_message_omitted(self):
  row=e.summarize_logs('nodered','2026-10-19T13:59:00Z [warn] private family calendar\n',self.now-3600,self.now)
  self.assertEqual(row['unclassified_lines'],1);self.assertNotIn('family',json.dumps(row))
 def test_timestamps_and_recurrence(self):
  raw='2026-10-19T13:59:00Z KeyError: secret\n2026-10-19T13:59:01Z KeyError: secret2\n'
  row=e.summarize_logs('homeassistant',raw,self.now-3600,self.now)
  self.assertEqual(row['events'][0]['occurrences'],2)
 def test_outside_window_omitted(self):
  row=e.summarize_logs('nodered','2026-10-18T13:59:00Z ERROR secret\n',self.now-3600,self.now)
  self.assertEqual(row['sampled_lines'],0)
 def test_wrong_host_and_paths_rejected(self):
  for args in ({'host':'other'},{'host':'raspberry','path':'/etc/passwd'}):
   with self.assertRaises(ValueError):e.handle('backup_results',args)
 def test_pagination_requires_anchor(self):
  with self.assertRaises(ValueError):e.logs({'service':'nodered','offset':5},now=self.now)
 def test_rotation_detected(self):
  with self.assertRaisesRegex(ValueError,'log_window_changed'):
   synthetic_time='2026-10-19T14:00:00Z'
   e.logs({'service':'nodered','offset':5,'window_end':synthetic_time,'expected_digest':'a'*64},run=lambda _: '',now=self.now)
 def test_logs_command_bounded(self):
  with self.assertRaisesRegex(ValueError,'collection_size_limit'):
   e.bounded_command([sys.executable,'-c','print("x"*1000)'],limit=100)
 def test_logs_timeout_kills_child(self):
  import subprocess
  with self.assertRaises(subprocess.TimeoutExpired):e.bounded_command([sys.executable,'-c','import time;time.sleep(5)'],timeout=.1)
 def test_host_does_not_escalate(self):
  with patch.object(e.d,'host_diagnostics',return_value={'throttling':{'collection_error':'unavailable_or_invalid','coverage':[]}}):
   self.assertEqual(e.host()['evidence']['throttling']['collection_error'],'device_unavailable_to_unprivileged_private_devices_broker')

if __name__=='__main__':unittest.main()
