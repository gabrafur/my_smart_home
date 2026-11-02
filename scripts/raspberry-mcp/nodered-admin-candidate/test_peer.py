"""Synthetic only. Principal serializes tests; child does not execute these.
No real Root, proc, socket, HTTP, environment or credential operations.
"""
import contextlib
import copy
import hashlib
import importlib.util
from pathlib import Path
import re
import sys
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

g = load('peer_guard_candidate', 'native_guard.py')
engine = types.ModuleType('engine')
engine.OP, engine.SHA = re.compile('[a-f0-9]{32}'), re.compile('[a-f0-9]{64}')
engine.digest, engine.raw, engine.need = g.digest, g.raw, g.need
engine.valid_id = lambda v,p=engine.OP: type(v) is str and p.fullmatch(v) is not None
engine.exact = lambda v,fields: g.need(type(v) is dict and set(v)==set(fields),'scope_refused')
previous_engine = sys.modules.get('engine')
sys.modules['engine'] = engine
try:
    c = load('peer_coord_candidate', 'coordination.py')
finally:
    if previous_engine is None:del sys.modules['engine']
    else:sys.modules['engine']=previous_engine

HOST = '192.0.2.8'
PIN = {'family':'tcp4','local_address':'0.0.0.0','port':1880,'socket_inode':777}
TCP = '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n 0: 00000000:0758 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 777\n'
FIB = 'Main:\n  |-- 192.0.2.8\n     /32 host LOCAL\n'

def synthetic_pins(path):
    return {name: ([7,8,0,0,0o755] if name=='/' else
                   [7,9,1000,0,0o775 if name=='/usr/src/node-red' else 0o755])
            for name in g.runtime_ancestors(path)}

class FakeIO:
    def __init__(self):
        self.current={'birth_ticks':300,'state':'S','uids':[1000]*4,'gids':[1000]*4,
                      'root_identity':[7,8],'mountinfo_sha256':'4'*64,'netns_identity':[30,80]}
        self.observed={'local_address':'0.0.0.0','port':1880,'socket_inode':777,
                       'netns_identity':[30,80],'pid_owns_listener':True,'backend_ip_local':True,'tcp_family':'tcp4'}
        self.calls=0
    def held_locks(self,ctx,expected):
        g.need(ctx['lock_fds']==(10,11,12,13,14),'missing_real_descriptor_fixture')
        return list(expected.values())
    def process(self,pid):
        g.need(pid==222,'pid_changed');return copy.deepcopy(self.current)
    def runtime_file(self,pid,path,limit,parent_pins=None):
        g.need(parent_pins == synthetic_pins(path),'fixture_ancestor_pin_mismatch')
        return {'sha256':'3'*64 if path.endswith('settings.js') else '2'*64,
                'root_identity':[7,8],'uid':1000,'gid':1000,'descendants_no_symlinks':True,'ancestor_identity_pins_verified':parent_pins==synthetic_pins(path)}
    def peer_listener(self,pid,host,activation):
        g.need(pid==222 and host==HOST,'backend_scope_changed')
        self.calls+=1;return copy.deepcopy(self.observed)
    def prepare_peer_folder(self,lease):
        g.need(lease=='1'*32,'lease_changed');return True

class PeerGuardTests(unittest.TestCase):
    def setUp(self):
        self.io=FakeIO();self.files={};self.now=100.
        activation={'schema_version':1,'core_version':'5.0.9','pid':222,'birth_ticks':300,
          'uid':1000,'gid':1000,'root_identity':[7,8],'mountinfo_sha256':'4'*64,
          'image_digest':'sha256:'+'5'*64,'core_sha256':{p:'2'*64 for p in g.CORE_FILES},
          'settings_sha256':'3'*64,'context_store_modules':{'default':'memoryOnly','memoryOnly':'memory','persistent':'localfilesystem'},
          'runtime_file_owners':{p:[1000,1000] for p in g.RUNTIME_FILES},
          'netns_identity':[30,80],'backend_listener':copy.deepcopy(PIN),
          'runtime_ancestor_pins':{p:synthetic_pins(p) for p in g.RUNTIME_FILES}}
        self.files[g.ACTIVATION]=g.raw(activation);self.files[g.SOURCE]=b'synthetic_module'
        self.ctx={'lock_lease_id':'1'*32,'executing_pid':111,'locks_acquired_at':99.,
                  'lock_identities':{p:[1,2,0,0,384] for p in g.LOCKS},'lock_fds':(10,11,12,13,14)}
        self.doc={'engine':{'expires_at':1000},'shared_locks':self.ctx['lock_identities'],
                  'backend':{'host':HOST,'port':1880,'username':'synthetic','identity_sha256':'7'*64},
                  'native_guard_producer':{'mode':'inline','source_sha256':hashlib.sha256(self.files[g.SOURCE]).hexdigest(),
                  'runtime_activation_sha256':hashlib.sha256(self.files[g.ACTIVATION]).hexdigest(),
                  'isolated_review_sha256':'6'*64,'ledger_identities':{n:[1,2,0,0,384] for n in g.LEDGERS},
                  'existing_executor_source_sha256':{n:'9'*64 for n in g.EXISTING_SOURCES}}}
        def read(path,*args):return self.files[path]
        def create(path,value):
            g.need(path not in self.files,'immutable_peer_already_exists');self.files[path]=g.raw(value)
        self.guard=g.NativeGuard(self.doc,'8'*64,lambda:self.now,read,create,self.io)
        self.patches=[patch.object(g.os,'getpid',return_value=111),patch.object(g.os,'geteuid',return_value=0),patch.object(g,'__file__',str(g.SOURCE))]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
    def test_native_identity_fresh_each_call_no_auth_claim(self):
        with patch.object(g.secrets,'token_hex',side_effect=['a'*32,'b'*32]):
            a=self.guard.produce_peer(self.ctx);b=self.guard.produce_peer(self.ctx)
        self.assertNotEqual(a['proof_path'],b['proof_path']);self.assertEqual(self.io.calls,2)
        proof=g.decode(self.files[Path(a['proof_path'])])
        self.assertTrue(proof['backend_listener_identity_proven'])
        self.assertIsNone(proof['authenticated_Admin_API_enabled']);self.assertFalse(proof['authentication_proven'])
        self.assertNotIn(g.ATTESTATIONS/'peer.json',self.files)
    def test_duplicate_generation_is_never_overwritten(self):
        with patch.object(g.secrets,'token_hex',return_value='a'*32):
            self.guard.produce_peer(self.ctx)
            with self.assertRaisesRegex(ValueError,'immutable_peer'):self.guard.produce_peer(self.ctx)
    def test_namespace_and_pid_drift_refused(self):
        for key,val in [('netns_identity',[30,81]),('birth_ticks',301)]:
            with self.subTest(key=key):
                before=self.io.current[key];self.io.current[key]=val
                with self.assertRaisesRegex(ValueError,'runtime_process_or_mount_drift'):self.guard.produce_peer(self.ctx)
                self.io.current[key]=before
    def test_listener_inode_owner_and_ip_fail_closed(self):
        for key,val in [('socket_inode',778),('pid_owns_listener',False),('backend_ip_local',False)]:
            with self.subTest(key=key):
                before=self.io.observed[key];self.io.observed[key]=val
                with self.assertRaisesRegex(ValueError,'native_backend_listener_unconfirmed'):self.guard.produce_peer(self.ctx)
                self.io.observed[key]=before
    def test_host_outside_original_policy_refused(self):
        self.doc['backend']['host']='127.0.0.1'
        with self.assertRaisesRegex(ValueError,'fixed_peer_backend_address_refused'):self.guard.produce_peer(self.ctx)
    def test_fib_trie_requires_exact_host_local(self):
        self.assertEqual(g.local_ipv4_addresses(FIB),{HOST})
        self.assertEqual(g.local_ipv4_addresses(FIB.replace('/32 host LOCAL','/32 link BROADCAST')),set())
        self.assertEqual(g.local_ipv4_addresses(FIB.replace('/32 host LOCAL','/24 link UNICAST')),set())
        self.assertEqual(g.local_ipv4_addresses(FIB.replace('|--','garbage |--')),set())
    def test_tcp_requires_exact_inode_listening_address_and_port(self):
        self.assertEqual(g.ipv4_listener(TCP,PIN,HOST)['socket_inode'],777)
        for body in [TCP.replace(' 0A ',' 01 '),TCP.replace(' 777\n',' 778\n'),TCP.replace(':0758',':0759')]:
            with self.assertRaisesRegex(ValueError,'pinned_tcp_listener_missing'):g.ipv4_listener(body,PIN,HOST)
        with self.assertRaisesRegex(ValueError,'does_not_cover'):
            g.ipv4_listener(TCP,{**PIN,'local_address':'192.0.2.9'},HOST)
    def test_tcp_malformed_or_duplicate_rows_refused(self):
        with self.assertRaisesRegex(ValueError,'ambiguous'):g.ipv4_listener(TCP+TCP.splitlines(True)[1],PIN,HOST)
        with self.assertRaisesRegex(ValueError,'row_unknown'):g.ipv4_listener(TCP+'broken\n',PIN,HOST)

    def test_native_reader_checks_pid_descriptor_ownership(self):
        io=g.NativeIO();opened={};nextfd=[100]
        def opener(path,flags):
            path=Path(path)
            self.assertIn(path, [Path('/proc/222/net/tcp'),Path('/proc/222/net/fib_trie')])
            nextfd[0]+=1;opened[nextfd[0]]=TCP if path.name=='tcp' else FIB
            return nextfd[0]
        def reader(fd,maximum):return opened[fd].encode()
        fake_ns=types.SimpleNamespace(st_dev=30,st_ino=80)
        activation={'backend_listener':PIN,'netns_identity':[30,80]}
        with patch.object(g.os,'open',side_effect=opener), patch.object(g.os,'read',side_effect=reader), patch.object(g.os,'close'), \
             patch.object(g.Path,'stat',return_value=fake_ns), patch.object(g.Path,'iterdir',return_value=iter([Path('/proc/222/fd/10')])), \
             patch.object(g.os,'readlink',return_value='socket:[777]'):
            result=io.peer_listener(222,HOST,activation)
            self.assertTrue(result['pid_owns_listener'])
        with patch.object(g.os,'open',side_effect=opener), patch.object(g.os,'read',side_effect=reader), patch.object(g.os,'close'), \
             patch.object(g.Path,'stat',return_value=fake_ns), patch.object(g.Path,'iterdir',return_value=iter([Path('/proc/222/fd/10')])), \
             patch.object(g.os,'readlink',return_value='socket:[778]'):
            with self.assertRaisesRegex(ValueError,'does_not_own_listener'):io.peer_listener(222,HOST,activation)

class AncestorPinTests(unittest.TestCase):
    @staticmethod
    def info(mode=0o775,uid=1000,gid=0,inode=12):
        return types.SimpleNamespace(st_dev=96,st_ino=inode,st_uid=uid,st_gid=gid,st_mode=g.stat.S_IFDIR|mode)
    def test_exact_gid_zero_group_write_exception_only(self):
        name='/usr/src/node-red';pins={name:[96,12,1000,0,0o775]}
        g.verify_runtime_ancestor(self.info(),name,pins)
        with self.assertRaisesRegex(ValueError,'group_write_not_root_group'):
            g.verify_runtime_ancestor(self.info(gid=1000),name,{name:[96,12,1000,1000,0o775]})
    def test_inode_owner_or_mode_drift_refused(self):
        name='/usr/src/node-red';pins={name:[96,12,1000,0,0o775]}
        for info in [self.info(inode=13),self.info(uid=0),self.info(mode=0o755)]:
            with self.assertRaisesRegex(ValueError,'ancestor_identity_changed'):g.verify_runtime_ancestor(info,name,pins)
    def test_world_write_refused_even_if_pinned_root_group(self):
        name='/usr/src/node-red';pins={name:[96,12,1000,0,0o777]}
        with self.assertRaisesRegex(ValueError,'world_writable'):g.verify_runtime_ancestor(self.info(mode=0o777),name,pins)
    def test_symlink_never_becomes_trusted_directory(self):
        name='/usr/src/node-red';info=self.info();info.st_mode=g.stat.S_IFLNK|0o775
        with self.assertRaisesRegex(ValueError,'not_directory'):g.verify_runtime_ancestor(info,name,{name:[96,12,1000,0,0o775]})
    def test_missing_pins_keep_strict_default(self):
        g.verify_runtime_ancestor(self.info(mode=0o755),'/usr/src/node-red')
        with self.assertRaisesRegex(ValueError,'ancestor_writable'):g.verify_runtime_ancestor(self.info(),'/usr/src/node-red')
    def test_pin_map_covers_every_component_and_no_free_paths(self):
        path=g.CORE_FILES[0]
        expected=g.runtime_ancestors(path)
        self.assertEqual(expected[0],'/');self.assertEqual(expected[-1],g.CORE+'nodes')
        partial=synthetic_pins(path);del partial['/usr']
        with self.assertRaisesRegex(ValueError,'pin_scope_unknown'):
            g.NativeIO().runtime_file(222,path,2097152,partial)
        with self.assertRaisesRegex(ValueError,'outside_fixed_scope'):g.runtime_ancestors('/arbitrary')


    def test_total_attestation_quota_is_reused_without_pruning(self):
        info=types.SimpleNamespace(st_mode=g.stat.S_IFREG|0o600,st_uid=0,st_gid=0,st_size=64*1048576)
        io=g.NativeIO()
        with patch.object(g.os,'walk',return_value=[(str(g.ATTESTATIONS),[],['proof.json'])]),patch.object(g.Path,'lstat',return_value=info):
            with self.assertRaisesRegex(ValueError,'storage_capacity'):io.check_attestation_quota(32768,3)
        info.st_size=0
        with patch.object(g.os,'walk',return_value=[(str(g.ATTESTATIONS),[],[str(i) for i in range(8190)])]),patch.object(g.Path,'lstat',return_value=info):
            with self.assertRaisesRegex(ValueError,'metadata_capacity'):io.check_attestation_quota(32768,3)

class PeerCoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.coord=c.RootCoordinator.__new__(c.RootCoordinator)
        self.coord.document={'backend':{'host':HOST,'port':1880,'identity_sha256':'7'*64},
                            'sources':{'native_guard.py':'2'*64},
                            'native_guard_producer':{'runtime_activation_sha256':'3'*64}}
        self.coord.root_policy_sha256='4'*64;self.coord.clock=lambda:100.
        self.coord.locked=True;self.coord.lock_lease_id='1'*32;self.coord.locks_acquired_at=99.
        self.coord._unchanged=lambda:None;self.coord._native_guard_ready=lambda:True
        self.coord._lease_context=lambda:{'lock_lease_id':'1'*32}
        self.count=0;self.files={};self.mode=None
        def produce(ctx):
            self.count+=1;nonce=('%032x'%self.count)
            path=c.ATTESTATIONS/'peer'/('1'*32)/(nonce+'.json')
            value={'schema_version':1,'producer':'sealed_nodered_admin_inline_peer',
              'root_policy_sha256':'4'*64,'loaded_source_sha256':'2'*64,'runtime_activation_sha256':'3'*64,
              'backend_identity_sha256':'7'*64,'host':HOST,'port':1880,'request_generation':nonce,
              'lock_lease_id':'1'*32,'executing_pid':111,'backend_listener_identity_proven':True,
              'authenticated_Admin_API_enabled':None,'authentication_proven':False,
              'observed_at':100.,'expires_at':105.}
            if self.mode=='stale':value['observed_at']=94.
            if self.mode=='future':value['observed_at']=101.
            self.files[path]=g.raw(value)
            return {'proof_path':str(path if self.mode!='oldpath' else c.ATTESTATIONS/'peer.json'),
                    'proof_sha256':g.digest(value),'request_generation':nonce}
        self.coord._inline_guard=types.SimpleNamespace(produce_peer=produce)
        self.reads=[]
        def read(path,*args):self.reads.append(path);return self.files[path]
        self.patches=[patch.object(c.os,'getpid',return_value=111),patch.object(c,'checked_read',side_effect=read)]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
    def test_reuses_existing_locks_and_always_collects_again(self):
        def badlocks():raise AssertionError('nested lock acquisition')
        self.coord.locks=badlocks
        self.assertTrue(self.coord.peer_check());self.assertTrue(self.coord.peer_check())
        self.assertEqual(self.count,2);self.assertEqual(len(set(self.reads)),2)
    def test_acquires_locks_for_auth_or_revoke_outside_engine(self):
        self.coord.locked=False;entered=[]
        @contextlib.contextmanager
        def locks():
            entered.append(True);self.coord.locked=True
            try:yield
            finally:self.coord.locked=False
        self.coord.locks=locks
        self.assertTrue(self.coord.peer_check());self.assertFalse(self.coord.locked);self.assertEqual(len(entered),1)
    def test_static_old_peer_proof_is_not_fallback(self):
        self.mode='oldpath'
        with self.assertRaisesRegex(ValueError,'outside_current_lease'):self.coord.peer_check()
        self.assertNotIn(c.ATTESTATIONS/'peer.json',self.reads)
    def test_stale_and_future_proof_rejected(self):
        for mode in ('stale','future'):
            self.mode=mode
            with self.assertRaisesRegex(ValueError,'current_backend_peer_unconfirmed'):self.coord.peer_check()

if __name__=='__main__':unittest.main()
