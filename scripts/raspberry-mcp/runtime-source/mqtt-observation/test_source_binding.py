import json,os,stat,unittest
from types import SimpleNamespace
from source_binding import (BindingUnavailable,Peer,SourcePolicy,SourceVerifier,
    start_ticks,credentials_from_status,cgroup_bound,zero_offsets,boot_domain,mapped_executable)

CID='a'*64
def policy(**kw):
    value=dict(container_id=CID,peer_uid=1883,peer_gid=1883,binary_sha256='b'*64,
               plugin_sha256='c'*64,plugin_path='/probe/plugin.so',plugin_owner_uid=1001)
    value.update(kw);return SourcePolicy(**value)

class BindingParserTests(unittest.TestCase):
    def test_cgroup_requires_exact_owned_container_leaf(self):
        cgroup_bound('0::/system.slice/docker-'+CID+'.scope\n',CID)
        cgroup_bound('0::/docker/'+CID+'\n',CID)
        for raw in ['0::/system.slice/docker-'+CID+'0.scope\n',
                    '0::/other/'+CID+'\n','0::/docker/'+CID+'/extra\n',
                    '0::/docker/'+CID+'\n0::/other\n']:
            with self.assertRaises(BindingUnavailable):cgroup_bound(raw,CID)
    def test_start_time_parser_handles_spaces_and_parentheses_in_comm(self):
        raw='77 (name ) with spaces) S '+' '.join(['0']*18+['123456']+['0']*4)
        self.assertEqual(start_ticks(raw,77),123456)
        with self.assertRaises(BindingUnavailable):start_ticks(raw,78)
        with self.assertRaises(BindingUnavailable):start_ticks(raw.replace(') S ',') Z '),77)
    def test_real_effective_saved_and_filesystem_credentials_must_all_match(self):
        peer=Peer(77,1883,1883)
        valid='Uid:\t1883 1883 1883 1883\nGid:\t1883 1883 1883 1883\n'
        credentials_from_status(valid,peer)
        for raw in [valid.replace('1883','0',1),valid+'Uid: 1883 1883 1883 1883\n',valid.split('Gid:')[0]]:
            with self.assertRaises(BindingUnavailable):credentials_from_status(raw,peer)
    def test_source_and_reader_time_offsets_must_both_be_zero(self):
        zero_offsets('monotonic 0 0\nboottime 0 0\n')
        for raw in ['monotonic 0 0\nboottime 1 0\n','monotonic 0 0\nboottime 0 -1\n',
                    'monotonic 0 0\nboottime 0 0\nboottime 0 0\n']:
            with self.assertRaises(BindingUnavailable):zero_offsets(raw)
    def test_boot_id_has_closed_syntax_and_is_exported_as_hash(self):
        value='12345678-abcd-1234-abcd-123456789abc'
        self.assertEqual(boot_domain(value),boot_domain(value+'\n'))
        self.assertEqual(len(boot_domain(value)),64)
        for raw in [value+'PRIVATE',value.upper(),'PRIVATE_SENTINEL']:
            with self.assertRaises(BindingUnavailable):boot_domain(raw)
    def test_mapping_requires_executable_same_device_inode_and_exact_path(self):
        info=SimpleNamespace(st_dev=os.makedev(8,2),st_ino=432)
        raw='1000-2000 r-xp 00000000 08:02 432 /probe/plugin.so\n'
        mapped_executable(raw,info,'/probe/plugin.so')
        for bad in [raw.replace('432','433'),raw.replace('08:02','08:03'),
                    raw.replace('r-xp','r--p'),raw.replace('plugin.so','plugin.so (deleted)'),
                    raw.replace('/probe/plugin.so','/else/plugin.so')]:
            with self.assertRaises(BindingUnavailable):mapped_executable(bad,info,'/probe/plugin.so')
    def test_policy_rejects_path_escape_and_unbounded_identity(self):
        for path in ['/probe/../plugin.so','/probe/./plugin.so','relative/plugin.so','/probe/plugin.so\n']:
            with self.assertRaises(BindingUnavailable):policy(plugin_path=path)
        for kwargs in [dict(peer_uid=True),dict(peer_gid=-1),dict(plugin_owner_uid=2**32),dict(container_id='a'*65)]:
            with self.assertRaises(BindingUnavailable):policy(**kwargs)
    def test_wrong_uid_is_rejected_before_process_metadata_is_read(self):
        verifier=SourceVerifier(policy())
        for peer in [Peer(os.getpid(),os.geteuid(),os.getegid()),Peer(0,1883,1883),Peer(True,1883,1883)]:
            with self.assertRaisesRegex(BindingUnavailable,'^source_peer_mismatch$'):verifier.verify(peer)
    def test_own_python_process_cannot_impersonate_broker(self):
        verifier=SourceVerifier(policy(peer_uid=os.geteuid(),peer_gid=os.getegid()))
        with self.assertRaisesRegex(BindingUnavailable,'^source_process_invalid$'):
            verifier.verify(Peer(os.getpid(),os.geteuid(),os.getegid()))

if __name__=='__main__':unittest.main()
