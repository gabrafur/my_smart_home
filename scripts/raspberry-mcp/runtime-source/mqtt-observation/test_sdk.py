"""No network or compiler; verify exact bytes and fail before any overwrite."""
import hashlib,importlib.util,tempfile,unittest
from pathlib import Path

path=Path(__file__).with_name('native')/'prepare_build.py'
spec=importlib.util.spec_from_file_location('_mqtt_prepare_build',path)
build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)

class SDKTests(unittest.TestCase):
    def record(self,raw):
        return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
                'git_blob_sha1':hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()}
    def test_sdk_set_and_source_are_closed_and_versioned(self):
        rows=build.records()
        self.assertEqual(len(rows),7)
        self.assertTrue(all(r['url']==build.PREFIX+r['path']for r in rows))
    def test_tampered_or_oversized_response_refused(self):
        raw=b'synthetic SDK data';record=self.record(raw)
        self.assertEqual(build.verify(record,raw),raw)
        for bad in [b'changed',raw+b'extra',b'',raw.decode()]:
            with self.assertRaises(ValueError):build.verify(record,bad)
        with self.assertRaises(ValueError):build.verify({**record,'bytes':65537},raw)
    def test_git_object_identity_is_checked_independently(self):
        raw=b'synthetic';record=self.record(raw);record['git_blob_sha1']='a'*40
        with self.assertRaisesRegex(ValueError,'git_blob_mismatch'):build.verify(record,raw)
    def test_preserved_license_texts_are_byte_exact_upstream_blobs(self):
        rows={r['path']:r for r in build.records()}
        for original,local in [('LICENSE.txt','LICENSE.sdk.txt'),('edl-v10','EDL-v1.0.txt'),('epl-v20','EPL-v2.0.txt')]:
            raw=(build.HERE/local).read_bytes()
            self.assertEqual(build.verify(rows[original],raw),raw)
    def test_existing_destination_never_downloaded_or_modified(self):
        with tempfile.TemporaryDirectory()as folder:
            root=Path(folder);sentinel=root/'preserve';sentinel.write_bytes(b'synthetic existing state')
            with self.assertRaises(FileExistsError):build.prepare(root,lambda *_:self.fail('must not fetch'))
            self.assertEqual(sentinel.read_bytes(),b'synthetic existing state')
    def test_bad_first_download_never_copies_compilable_source(self):
        with tempfile.TemporaryDirectory()as folder:
            target=Path(folder)/'new-context'
            with self.assertRaises(ValueError):build.prepare(target,lambda *_:b'changed SDK')
            self.assertFalse((target/'native_sender_authorized.c').exists())
            self.assertTrue(target.is_dir(),'failed context preserved for review')

if __name__=='__main__':unittest.main()
