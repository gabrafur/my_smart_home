import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

def load(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

wrapper=load('observed',Path(__file__).parent.parent / 'runtime-source/procmon-observability/observed_collector.py')

class AtomicModeTests(unittest.TestCase):
    def fixture(self):
        source=Path(__file__).with_name('collector.source.py')
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
            'd53a173123b0d6d96406e56bd73559fd5fd00d6dd040bf36cf2c21b978e1b277')
        return load('collector_fixture',source)

    def test_exact_modes_and_umask_are_preserved(self):
        mod=self.fixture();wrapper.Observer().install(mod)
        with tempfile.TemporaryDirectory()as name:
            previous=os.umask(0o077)
            try:
                for mode in [0o600,0o640]:
                    file=Path(name)/str(mode);mod.atomic(file,{'sample':True},mode=mode)
                    self.assertEqual(stat.S_IMODE(file.stat().st_mode),mode)
                self.assertEqual(os.umask(0o077),0o077)
            finally:os.umask(previous)

    def interrupted_creation(self, wrapped):
        mod=self.fixture()
        if wrapped:wrapper.Observer().install(mod)
        with tempfile.TemporaryDirectory()as name:
            state=Path(name)
            for part in ['history','hours','public']:(state/part).mkdir()
            real_open=os.open;handles=[]
            def interrupt(path,*args,**kwargs):
                fd=real_open(path,*args,**kwargs)
                if str(path).endswith('.tmp'):
                    handles.append(fd);raise TimeoutError('fixture_interruption_after_create')
                return fd
            previous=os.umask(0o077)
            try:
                with patch.object(mod.os,'open',side_effect=interrupt):
                    with self.assertRaises(TimeoutError):mod.atomic(state/'public/snapshot.json',{},mode=0o640)
                for fd in handles:os.close(fd)
                temporary=state/'public/snapshot.json.tmp'
                self.assertEqual(temporary.stat().st_size,0)
                if wrapped:
                    self.assertEqual(stat.S_IMODE(temporary.stat().st_mode),0o640)
                    rows=mod.preserve_interrupted(state)
                    self.assertEqual(len(rows),1)
                    self.assertFalse(temporary.exists())
                    self.assertFalse((state/'public/snapshot.json').exists())
                else:
                    self.assertEqual(stat.S_IMODE(temporary.stat().st_mode),0o600)
                    with self.assertRaisesRegex(ValueError,'unsafe_interrupted_sample'):mod.preserve_interrupted(state)
                    self.assertTrue(temporary.exists())
            finally:os.umask(previous)

    def test_original_creation_window_is_reproduced_only_in_isolated_fixture(self):
        self.interrupted_creation(False)

    def test_interruption_evidence_can_be_archived_without_promotion(self):
        self.interrupted_creation(True)

if __name__=='__main__':unittest.main()
