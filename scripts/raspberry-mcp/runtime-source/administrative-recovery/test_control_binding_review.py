import copy,json,unittest
from control_binding_review import candidates,POLICIES,encode,sha

class Review(unittest.TestCase):
    def setUp(self):
        legacy={'enabled':True,'approved_at':10,'approved_monotonic':20,'expires_at':30,'boot_id':'synthetic',
          'max_sends':6,'threads':['fixed_first','fixed_second'],'project':'fixed_project',
          'revision':'retain','source_hashes':{'synthetic':'a'*64},'peer_pid':10,'socket_identity':[35,11]}
        task={'legacy_policy_sha256':sha(encode(legacy)),'enabled':False,'expires_at':30,'max_sends_per_24h':48,
          'minimum_spacing_seconds':60,'future_gate':{'unchanged':True}}
        repair={'dependencies':{POLICIES['legacy']:sha(encode(legacy)),POLICIES['task']:sha(encode(task)),
          '/synthetic/unchanged':'c'*64},'expires_at':30,'maximum_submissions':2,'enabled':True}
        self.before={k:encode(v)for k,v in [('legacy',legacy),('task',task),('repair',repair)]}
        self.peer={'socket_identity':[35,200],'peer_pid':100,'peer_uid':1001,'peer_gid':1001,
          'socket_uid':1001,'socket_mode':0o600,'process_start_ticks':'999','executable_sha256':'f'*64}
    def test_only_fixed_identity_and_dependency_references_change(self):
        before=copy.deepcopy(self.before);after=candidates(before,self.peer)
        self.assertEqual(before,self.before)
        old={k:json.loads(v)for k,v in before.items()};new={k:json.loads(v)for k,v in after.items()}
        self.assertEqual(new['legacy']['peer_pid'],100);self.assertEqual(new['legacy']['socket_identity'],[35,200])
        self.assertEqual(new['task']['legacy_policy_sha256'],sha(after['legacy']))
        for kind in('legacy','task'):self.assertEqual(new['repair']['dependencies'][POLICIES[kind]],sha(after[kind]))
        for key in set(old['legacy'])-{'peer_pid','socket_identity'}:self.assertEqual(new['legacy'][key],old['legacy'][key])
        for key in set(old['task'])-{'legacy_policy_sha256'}:self.assertEqual(new['task'][key],old['task'][key])
        for key in set(old['repair'])-{'dependencies'}:self.assertEqual(new['repair'][key],old['repair'][key])
        self.assertEqual(new['repair']['dependencies']['/synthetic/unchanged'],'c'*64)
    def test_wrong_owner_mode_or_peer_is_refused(self):
        for key,value in [('peer_uid',0),('peer_gid',0),('socket_uid',0),('socket_mode',0o666),('peer_pid',True)]:
            with self.subTest(key=key),self.assertRaises(ValueError):candidates(self.before,{**self.peer,key:value})
    def test_no_arbitrary_attestation_or_policy_scope(self):
        for value in [{}, {**self.peer,'path':'/arbitrary'}]:
            with self.assertRaisesRegex(ValueError,'attestation_scope'):candidates(self.before,value)
        with self.assertRaisesRegex(ValueError,'policy_scope'):candidates({**self.before,'new':b'{}'},self.peer)
    def test_code_and_process_identity_are_required(self):
        for key,value in [('process_start_ticks','0'),('process_start_ticks',1),('executable_sha256','unconfirmed')]:
            with self.subTest(key=key),self.assertRaises(ValueError):candidates(self.before,{**self.peer,key:value})
    def test_old_policy_dependency_drift_is_not_adopted(self):
        for kind in('legacy','task'):
            before=copy.deepcopy(self.before);repair=json.loads(before['repair']);repair['dependencies'][POLICIES[kind]]='0'*64;before['repair']=encode(repair)
            with self.assertRaisesRegex(ValueError,'dependency_baseline_changed'):candidates(before,self.peer)
    def test_task_legacy_pin_drift_is_refused(self):
        before=copy.deepcopy(self.before);task=json.loads(before['task']);task['legacy_policy_sha256']='0'*64;before['task']=encode(task)
        with self.assertRaisesRegex(ValueError,'task_baseline_changed'):candidates(before,self.peer)
    def test_lost_return_reapplication_is_not_another_rebind(self):
        after=candidates(self.before,self.peer)
        with self.assertRaisesRegex(ValueError,'already_applied'):candidates(after,self.peer)

if __name__=='__main__':unittest.main()
