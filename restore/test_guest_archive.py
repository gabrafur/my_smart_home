"""Synthetic regressions; no backup, key, Docker or residential access."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

import guest_archive as g


def archive(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as tar:
        for name, body, kind in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.size = len(body)
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                item.linkname = "../../outside"
            tar.addfile(item, io.BytesIO(body) if kind == tarfile.REGTYPE else None)
    return out.getvalue()


def bundle():
    return [("data/backups/offsite-staging-fixture/" + n, b"{}", tarfile.REGTYPE)
            for n in ("bundle.json", "manifest.yaml", "checksums.json")]


def native():
    return [("data/" + n, b"fixture", tarfile.REGTYPE) for n in (
        "configuration.yaml", ".storage/auth", ".storage/core.config_entries",
        ".storage/core.entity_registry", ".storage/core.device_registry", "home-assistant_v2.db")]


def securetar_fixture(payload, *, bad_tail=False, version=3):
    state = {"fully_read": False}

    class Stream(io.BytesIO):
        def read(self, count=-1):
            if self.tell() == len(payload):
                state["fully_read"] = True
                if bad_tail:
                    raise ValueError("synthetic_authentication_failed")
            return super().read(count)

    class Outer:
        def __init__(self, **_):
            self.member = tarfile.TarInfo("homeassistant.tar")
            self.tar = self

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def __iter__(self):
            return iter([self.member])

        def extractfile(self, _):
            return io.BytesIO(b"fixture header")

        def extract_tar(self, _):
            return Stream(payload)

    class Header:
        @staticmethod
        def from_bytes(_):
            return types.SimpleNamespace(version=version, plaintext_size=len(payload))

    return (Outer, Header), state


class GuestArchiveTests(unittest.TestCase):
    def test_native_includes_recorder_and_skips_nested_backup_without_exporting_paths(self):
        rows = native() + [("data/backups/nested.tar", b"nested", tarfile.REGTYPE)]
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / "out"
            proof = g.extract_inner(io.BytesIO(archive(rows)), dst, "homeassistant")
            self.assertEqual(proof["selected_files"], len(native()))
            self.assertFalse((dst / "backups").exists())
            self.assertEqual((dst / "home-assistant_v2.db").read_bytes(), b"fixture")
            self.assertNotIn(".storage", json.dumps(proof))
            self.assertNotIn("fixture", json.dumps(proof))

    def test_traversal_links_duplicate_and_unknown_native_roots_refuse(self):
        cases = [
            [("data/../outside", b"x", tarfile.REGTYPE)],
            [("data/link", b"", tarfile.SYMTYPE)],
            [("data/hard", b"", tarfile.LNKTYPE)],
            [("data/fifo", b"", tarfile.FIFOTYPE)],
            [("data/duplicate", b"a", tarfile.REGTYPE), ("data/duplicate", b"b", tarfile.REGTYPE)],
            [("unexpected/configuration.yaml", b"x", tarfile.REGTYPE)],
        ]
        for rows in cases:
            with self.subTest(rows=rows), tempfile.TemporaryDirectory() as tmp:
                dst = Path(tmp) / "out"
                with self.assertRaises(ValueError):
                    g.extract_inner(io.BytesIO(archive(rows)), dst, "homeassistant")
                self.assertFalse((Path(tmp) / "outside").exists())
                self.assertFalse((dst / g.SEAL).exists())

    def test_sparse_member_and_selected_byte_limits_refuse_before_payload_write(self):
        sparse = tarfile.TarInfo("data/sparse")
        sparse.sparse = [(0, 1)]
        opened = unittest.mock.MagicMock()
        opened.__enter__.return_value = [sparse]
        with tempfile.TemporaryDirectory() as tmp, patch.object(g.tarfile, "open", return_value=opened):
            dst = Path(tmp) / "out"
            with self.assertRaisesRegex(ValueError, "archive_sparse_object"):
                g.extract_inner(io.BytesIO(), dst, "homeassistant")
            self.assertFalse((dst / "sparse").exists())
        for key in ("MAX_SELECTED_BYTES", "MAX_FILE_BYTES"):
            with tempfile.TemporaryDirectory() as tmp, patch.object(g, key, {"compose": 1}), self.assertRaisesRegex(ValueError, "selected_archive_size_limit"):
                dst = Path(tmp) / "out"
                g.extract_inner(io.BytesIO(archive(bundle())), dst, "compose")
                self.fail("oversized payload accepted")

    def test_bundle_selection_refuses_second_root_and_reserved_seal(self):
        cases = [bundle() + [("data/backups/offsite-staging-other/extra", b"x", tarfile.REGTYPE)],
                 bundle() + [("data/backups/offsite-staging-fixture/" + g.SEAL, b"{}", tarfile.REGTYPE)]]
        for rows in cases:
            with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ValueError):
                g.extract_inner(io.BytesIO(archive(rows)), Path(tmp) / "out", "compose")

    def test_v3_requires_full_tail_authentication_before_seal(self):
        for bad in (False, True):
            types_, state = securetar_fixture(archive(bundle()), bad_tail=bad)
            with tempfile.TemporaryDirectory() as tmp:
                dst = Path(tmp) / "out"
                if bad:
                    with self.assertRaisesRegex(ValueError, "synthetic_authentication_failed"):
                        g.extract_authenticated("fixture", "synthetic-only", dst, "compose", securetar_types=types_)
                    self.assertFalse((dst / g.SEAL).exists())
                else:
                    proof = g.extract_authenticated("fixture", "synthetic-only", dst, "compose", securetar_types=types_)
                    self.assertTrue(proof["authenticated"])
                    self.assertFalse(proof["services_started"])
                    self.assertEqual(json.loads((dst / g.SEAL).read_bytes()), proof)
                    self.assertNotIn("synthetic-only", (dst / g.SEAL).read_text())
                self.assertTrue(state["fully_read"])

    def test_legacy_crypto_empty_recorder_existing_output_and_expansion_limits_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / "out"
            types_, _ = securetar_fixture(archive(bundle()), version=2)
            with self.assertRaisesRegex(ValueError, "authenticated_encryption_not_proven"):
                g.extract_authenticated("fixture", "synthetic-only", dst, "compose", securetar_types=types_)
            self.assertFalse(dst.exists())
            rows = native()
            rows[-1] = (rows[-1][0], b"", tarfile.REGTYPE)
            with self.assertRaisesRegex(ValueError, "restored_recorder_empty"):
                g.extract_inner(io.BytesIO(archive(rows)), dst, "homeassistant")
            with self.assertRaisesRegex(ValueError, "destination_exists"):
                g.extract_inner(io.BytesIO(archive(native())), dst, "homeassistant")
        for setting, value in [("MAX_EXPANDED_BYTES", 1), ("MAX_MEMBERS", 1)]:
            with tempfile.TemporaryDirectory() as tmp, patch.object(g, setting, value), self.assertRaises(ValueError):
                g.extract_inner(io.BytesIO(archive(bundle())), Path(tmp) / "out", "compose")


if __name__ == "__main__":
    unittest.main()
