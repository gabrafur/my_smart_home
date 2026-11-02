import hashlib,unittest
from public_source_validator import source_entry
class SourceTests(unittest.TestCase):
 def setUp(self):
  self.body=b'return msg;\n';self.blob=hashlib.sha1(b'blob '+str(len(self.body)).encode()+b'\0'+self.body).hexdigest()
 def entry(self,value='return msg;',blob=None):return source_entry('node','func',value,'a'*40,blob or self.blob,self.body,'b'*32,b'public reviewed diff')
 def test_exact_public_source(self):self.assertEqual(self.entry()['entry']['value'],'return msg;')
 def test_private_tail_refused(self):
  with self.assertRaises(ValueError):self.entry('return msg; private')
 def test_wrong_blob_refused(self):
  with self.assertRaises(ValueError):self.entry(blob='c'*40)
 def test_builder_does_not_claim_commit_reachability(self):self.assertTrue(self.entry()['requires_root_public_commit_reachability_review'])
if __name__=='__main__':unittest.main()
