#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path

from canary_state import CanaryStore, assignment_bucket, audit_events, read_events


CONFIG = {
    "master_switch": True, "structured_extraction": True, "rollout_percentage": 10,
    "model": "qwen2.5-coder:14b", "model_digest": "digest", "schema_version": "structured-extraction-v1",
    "assignment_version": "structured-extraction-canary-v1",
}
VERSION = "structured-extraction-canary-v1"
SALT = "residual-structured-extraction-v1"


def event(index: int, *, accepted: bool = True, fallback: bool = False, status: str = "completed"):
    anonymous = f"{index:064x}"
    bucket = assignment_bucket(anonymous, VERSION, SALT)
    return {
        "task_id": anonymous, "job_id": str(uuid.uuid4()), "attempt_id": str(uuid.uuid4()),
        "activity": "structured_extraction", "execution_mode": "production_canary",
        "excluded_from_operational_metrics": False, "parser_status": "UNSUPPORTED",
        "residual_eligible": True, "route_kind": "production_canary", "rollout_percentage": 100,
        "canary_assignment_version": VERSION, "stable_bucket": bucket, "selected_for_canary": True,
        "model": "qwen2.5-coder:14b", "model_digest": "digest", "inference_status": status,
        "inference_started": True, "inference_completed": status == "completed", "schema_status": "valid",
        "validation_status": "accepted" if accepted else "rejected", "accepted": accepted,
        "fallback": fallback, "fallback_reason": "safe" if fallback else None,
        "critical_error": False, "critical_errors": [], "safe_local_resolution": accepted,
        "validation_trace": [{
            "field_name": "record_id", "validation_rule": "source", "validation_status": "valid",
            "source_evidence_hash": "a" * 64, "normalized_value_hash": "a" * 64,
        }],
        "validation_metrics": {
            "critical_field_recall": 1.0, "numeric_preservation": 1.0,
            "invented_critical_fields": 0, "critical_omissions": 0, "contradiction_count": 0,
        },
        "timestamp_utc": "2026-08-25T00:00:00Z",
    }


class CanaryStateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = CanaryStore(root / "events.jsonl", root / "breaker.json", root / "summary.json")

    def tearDown(self):
        self.temporary.cleanup()

    def test_breaker_defaults_closed_and_persists_open_across_restart(self):
        self.assertEqual(self.store.breaker()["state"], "CLOSED")
        self.store.set_breaker("OPEN", "critical_incident")
        restarted = CanaryStore(self.store.events_path, self.store.breaker_path, self.store.summary_path)
        self.assertEqual(restarted.breaker()["state"], "OPEN")

    def test_claim_prevents_duplicate_attempt_after_retry(self):
        self.assertTrue(self.store.claim("a" * 64, "job-1"))
        self.assertFalse(self.store.claim("a" * 64, "job-2"))
        self.store.complete_claim("a" * 64, "accepted")
        self.assertTrue(self.store.has_processed("a" * 64))

    def test_probe_events_are_excluded_from_operational_summary(self):
        probe = event(1); probe["execution_mode"] = "canary_probe"; probe["excluded_from_operational_metrics"] = True
        summary = self.store.append(probe, CONFIG)
        self.assertEqual(summary["metrics"]["local_inference_attempts"], 0)
        self.assertEqual(summary["status"], "CANARY_ACTIVE_INSUFFICIENT_OPERATIONAL_SAMPLE")

    def test_manual_hold_opens_after_twenty_real_attempts_over_gate(self):
        for index in range(20):
            self.store.append(event(index, accepted=index >= 2, fallback=index < 2), CONFIG)
        self.store.apply_statistical_hold(CONFIG)
        self.assertEqual(self.store.breaker()["state"], "MANUAL_HOLD")

    def test_audit_rejects_duplicate_and_missing_trace_but_insufficient_sample_is_successful(self):
        first = event(1)
        result = audit_events([first], expected_model="qwen2.5-coder:14b", expected_digest="digest", assignment_version=VERSION, rollout_salt=SALT)
        self.assertEqual(result["audit_status"], "PASS")
        self.assertEqual(result["operational_gate_status"], "INSUFFICIENT_SAMPLE")
        duplicate = dict(first); duplicate["validation_trace"] = []
        broken = audit_events([first, duplicate], expected_model="qwen2.5-coder:14b", expected_digest="digest", assignment_version=VERSION, rollout_salt=SALT)
        self.assertIn("duplicate_attempt_id", broken["critical_violations"])
        self.assertIn("accepted_without_complete_validation_trace", broken["critical_violations"])

    def test_private_event_writer_rejects_raw_payload_fields(self):
        unsafe = event(1); unsafe["source"] = "private"
        with self.assertRaisesRegex(ValueError, "forbidden_private_event_fields"):
            self.store.append(unsafe, CONFIG)
        self.assertEqual(read_events(self.store.events_path), [])


if __name__ == "__main__":
    unittest.main()
