"""Synthetic fixtures only; no real receipt, network, root or host files."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('candidate_broker',Path(__file__).with_name('broker.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

class Prior:
    def __init__(self): self.catalog={'0'*32:{}};self.calls=[]
    def handle(self,name,args):
        self.calls.append((name,args))
        if name=='project_files': return {'files':[{'file_id':'0'*32,'path':'docs/existing.md'}], 'next_offset':30,'total':466}
        return {'legacy':True}

class ReviewedTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.patcher=patch.object(b,'REVIEWED_ROOT',str(self.root));self.patcher.start();self.addCleanup(self.patcher.stop)
        self.contents={p:('synthetic '+str(i)+'\n')*1100 for i,p in enumerate(b.REVIEWED_PATHS)}
        for path,text in self.contents.items():
            p=self.root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
        self.receipt={'schema_version':1,'source':'reviewed_public_MCP_docs_v1','public_head':'a'*40,'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'files':{p:hashlib.sha256(t.encode()).hexdigest() for p,t in self.contents.items()}}
        self.receipt_module=types.SimpleNamespace(root_file=lambda *_args,**_kwargs:('ignored',json.dumps(self.receipt).encode(),None))
        self.modules=patch.dict(sys.modules,{'native_manager':self.receipt_module,'controller':types.SimpleNamespace(TOOLS=())});self.modules.start();self.addCleanup(self.modules.stop)
        self.engine=b.compose(Prior,None)()
    def test_catalog_append_and_native_pagination_unchanged(self):
        out=self.engine.handle('project_files',{'host':'raspberry','category':'docs','offset':0})
        self.assertEqual(len(out['files']),4);self.assertEqual(out['total'],466);self.assertEqual(out['next_offset'],30)
        self.assertTrue(all(x['read_only'] for x in out['files'][1:]))
        later=self.engine.handle('project_files',{'host':'raspberry','category':'docs','offset':30})
        self.assertEqual(len(later['files']),1)
    def test_read_chunks_and_edits_refused(self):
        ident,path=next(iter(b.reviewed_ids().items()))
        args={'host':'raspberry','file_id':ident,'offset':0}
        first=self.engine.handle('project_read',args)
        self.assertEqual(first['source'],'root_owned_reviewed_public_docs_receipt')
        self.assertEqual(first['observed_at'],self.receipt['observed_at'])
        self.assertGreaterEqual(first['age_seconds'],0);self.assertIsNone(first['collection_error'])
        self.assertEqual(first['reviewed_head'],'a'*40);self.assertEqual(first['deployment'],'source_only')
        self.assertIn('receipt_time_not_live_git_head',first['coverage'])
        second=self.engine.handle('project_read',{**args,'offset':first['next_offset']})
        self.assertEqual(first['text']+second['text'],self.contents[path][:8000])
        with self.assertRaisesRegex(ValueError,'read_only_catalog_target'):
            self.engine.handle('project_prepare_edit',{'host':'raspberry','file_id':ident})
        self.assertFalse(any(name=='project_prepare_edit' for name,_ in self.engine.calls))
    def test_changed_file_symlink_and_receipt_refuse(self):
        ident,path=next(iter(b.reviewed_ids().items()));p=self.root/path
        args={'host':'raspberry','file_id':ident,'offset':0}
        p.write_text('modified')
        with self.assertRaises(ValueError):self.engine.handle('project_read',args)
        p.unlink();p.symlink_to(self.root/b.REVIEWED_PATHS[1])
        with self.assertRaises(ValueError):self.engine.handle('project_read',args)
        self.receipt['files'].pop(path)
        with self.assertRaises(ValueError):self.engine.handle('project_read',args)
    def test_each_chunk_rechecks_hash_and_hardlinks_are_refused(self):
        ident,path=next(iter(b.reviewed_ids().items()));p=self.root/path
        args={'host':'raspberry','file_id':ident,'offset':0}
        first=self.engine.handle('project_read',args)
        p.write_text('changed after first chunk')
        with self.assertRaises(ValueError):
            self.engine.handle('project_read',{**args,'offset':first['next_offset']})
        p.write_text(self.contents[path]);(self.root/'extra-hardlink').hardlink_to(p)
        with self.assertRaises(ValueError):self.engine.handle('project_read',args)
    def test_collision_and_free_parameters_are_rejected(self):
        ident=next(iter(b.reviewed_ids()));self.engine.catalog[ident]={}
        with self.assertRaisesRegex(ValueError,'collision'):
            self.engine.handle('project_files',{'host':'raspberry','category':'docs','offset':0})
        with self.assertRaisesRegex(ValueError,'collision'):
            self.engine.handle('project_read',{'host':'raspberry','file_id':ident,'offset':0})
        del self.engine.catalog[ident]
        with self.assertRaises(ValueError):
            self.engine.handle('project_read',{'host':'raspberry','file_id':ident,'offset':0,'path':'/etc/passwd'})
    def test_other_calls_remain_legacy(self):
        self.assertEqual(self.engine.handle('project_read',{'host':'raspberry','file_id':'0'*32,'offset':0}),{'legacy':True})

    def test_catalog_survives_missing_receipt_and_changed_document(self):
        args={'host':'raspberry','category':'docs','offset':0}
        def missing(*_args,**_kwargs): raise FileNotFoundError()
        self.receipt_module.root_file=missing
        out=self.engine.handle('project_files',args)
        self.assertEqual(out['files'],[{'file_id':'0'*32,'path':'docs/existing.md'}])
        self.assertEqual((out['total'],out['next_offset']),(466,30))
        self.assertEqual(out['reviewed_virtual_roots'],0)
        self.assertEqual(out['reviewed_observation']['state'],'unknown')
        self.assertEqual(out['reviewed_observation']['collection_error'],'reviewed_docs_receipt_unavailable')
        self.receipt_module.root_file=lambda *_args,**_kwargs:('ignored',json.dumps(self.receipt).encode(),None)
        (self.root/b.REVIEWED_PATHS[0]).write_text('changed')
        out=self.engine.handle('project_files',args)
        self.assertEqual(len(out['files']),1);self.assertEqual((out['total'],out['next_offset']),(466,30))
        self.assertEqual(out['reviewed_observation']['collection_error'],'reviewed_docs_file_unavailable_or_changed')
        self.assertEqual(out['reviewed_virtual_roots'],0)

    def test_read_rejects_bad_offset_types_extra_arguments_and_past_end(self):
        ident,path=next(iter(b.reviewed_ids().items()))
        for value in (True,-1,'0',None,len(self.contents[path])+1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.engine.handle('project_read',{'host':'raspberry','file_id':ident,'offset':value})
        with self.assertRaises(ValueError):
            self.engine.handle('project_read',{'host':'raspberry','file_id':ident,'offset':0,'extra':True})

if __name__=='__main__':unittest.main()
