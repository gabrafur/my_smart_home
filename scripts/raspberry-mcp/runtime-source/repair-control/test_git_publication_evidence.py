"""Synthetic fixed-log evidence; no Git, network, credentials or runtime reads."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('publication_projection', Path(__file__).with_name('health_summary.py'))
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
FAIL = '2026-11-08T04:00:12+00:00'
AT = '2026-11-08T13:17:04+00:00'
NOW = h.stamp('2026-11-08T14:00:00+00:00')
SHA = 'a' * 40


def failure(at=FAIL):
    return ('[2026-11-08T04:00:02+00:00] backup started\n'
        'Documentation check failed (4 issue(s)):\n'
        '- docs/DEPENDENCY_PROVENANCE.en.md:31: referenced path is missing or untracked: homeassistant/custom_components/hacs/\n'
        '- docs/DEPENDENCY_PROVENANCE.md:33: referenced path is missing or untracked: homeassistant/custom_components/hacs/\n'
        '- docs/i18n-manifest.json: classified path is outside human documentation scope: homeassistant/custom_components/hacs/validate/README.md\n'
        '- missing tracked i18n document: homeassistant/custom_components/hacs/validate/README.md\n'
        f'[{at}] backup failed: could not push origin/main reason=validation_failed\n')


def receipt(at=AT, correction='hacs_documentation_references', failure_at=FAIL):
    return f'[{at}] git publication verified: origin=interactive commit={SHA} remote_commit={SHA} correction={correction} failure_at={failure_at}\n'


class EvidenceTests(unittest.TestCase):
    def project(self, log):
        return h.verified_publication(log, NOW, h.validation_diagnosis(log, NOW))

    def test_exact_failure_and_independent_remote_verification(self):
        log = failure() + receipt()
        d = h.validation_diagnosis(log, NOW); p = self.project(log)
        self.assertEqual(d['cause'], 'hacs_documentation_references')
        self.assertEqual(d['failure_at'], FAIL)
        self.assertFalse(d['recovery_proven'])
        self.assertTrue(p['correction_link_verified'])
        self.assertEqual(p['commit'], SHA)
        for value in (d, p):
            self.assertIsNone(value['collection_error'])
            self.assertGreater(value['age_seconds'], 0)
            self.assertTrue(value['source']); self.assertTrue(value['coverage'])

    def test_missing_complete_cycle_or_unrecognized_issue_is_unknown(self):
        for log in [failure().split('\n', 1)[1], failure().replace('backup failed:', 'backup deferred:'),
                    failure().replace('README.md', 'PRIVATE'), failure().replace('(4 issue(s))', '(5 issue(s))')]:
            self.assertEqual(h.validation_diagnosis(log, NOW)['state'], 'unknown')
            self.assertFalse(self.project(log + receipt())['correction_link_verified'])
            self.assertNotIn('PRIVATE', str(h.validation_diagnosis(log, NOW)))

    def test_no_changes_or_legacy_push_never_creates_verified_remote_receipt(self):
        for tail in [f'[{AT}] backup finished: no changes\n', f'[{AT}] backup finished: pushed abc1234\n']:
            self.assertEqual(self.project(failure() + tail)['state'], 'unknown')

    def test_future_invalid_hash_inequality_unknown_origin_and_extra_data_fail_closed(self):
        for line in [receipt(at='2099-01-01T00:00:00Z'), receipt().replace('remote_commit=' + SHA, 'remote_commit=' + 'b' * 40),
                     receipt().replace(SHA, 'badsha'), receipt().replace('origin=interactive', 'origin=PRIVATE'),
                     receipt().rstrip() + ' secret=PRIVATE\n', receipt().replace(AT, 'bad-date'),
                     receipt(correction='none'), receipt(failure_at='none')]:
            result = self.project(failure() + line)
            self.assertEqual(result['state'], 'unknown')
            self.assertIsNotNone(result['collection_error'])
            self.assertNotIn('PRIVATE', str(result))

    def test_wrong_failure_link_does_not_invent_correction(self):
        result = self.project(failure() + receipt(failure_at='2026-11-07T04:00:12Z'))
        self.assertEqual(result['state'], 'observed')
        self.assertFalse(result['correction_link_verified'])

    def test_unlinked_remote_observation_is_valid(self):
        result = self.project(receipt(correction='none', failure_at='none'))
        self.assertEqual(result['state'], 'observed')
        self.assertFalse(result['correction_link_verified'])

    def test_malformed_after_valid_or_nonmonotonic_receipts_not_ignored(self):
        for suffix in ['git publication verified: PRIVATE\n', receipt(at='2026-11-08T12:00:00Z')]:
            self.assertEqual(self.project(failure() + receipt() + suffix)['state'], 'unknown')

    def test_provenance_is_additive_and_old_failure_is_preserved(self):
        source = {'data': {'git': {'status': 'failed', 'reason': 'validation_failed', 'finished_at': FAIL,
            'exit_code': 1, 'evidence': {'collection_error': None}}, 'offsite': {'status': 'unknown'}}, 'coverage': []}
        before = copy.deepcopy(source)
        result = h.correct_backups(source, failure() + receipt(), NOW)
        git = result['data']['git']
        self.assertEqual(source, before)
        self.assertEqual(git['status'], 'failed')
        self.assertEqual(git['last_worker_cycle']['status'], 'failed')
        self.assertEqual(git['last_observed_publication']['state'], 'unknown')
        self.assertFalse(git['summary']['scheduled_success_proven'])
        self.assertEqual(result['data']['offsite'], before['data']['offsite'])
        self.assertTrue(git['verified_publication']['correction_link_verified'])

    def test_later_worker_observation_does_not_erase_historical_correction(self):
        later = '2026-11-08T13:30:00Z'
        log = (failure() + receipt() + f'[{later}] backup finished: no changes\n'
               + receipt(at=later, correction='none', failure_at='none').replace('origin=interactive', 'origin=worker'))
        source = {'data': {'git': {'status': 'success', 'reason': 'none', 'finished_at': later,
            'exit_code': 0, 'evidence': {'collection_error': None}}, 'offsite': {'status': 'unknown'}}, 'coverage': []}
        git = h.correct_backups(source, log, NOW)['data']['git']
        self.assertEqual(git['verified_publication']['origin'], 'worker')
        self.assertEqual(git['verified_publication']['observed_at'], later)
        self.assertEqual(git['verified_publication']['correction'], 'none')
        previous = git['last_verified_correction']
        self.assertEqual(previous['origin'], 'interactive')
        self.assertEqual(previous['observed_at'], AT)
        self.assertEqual(previous['failure_at'], FAIL)
        self.assertTrue(previous['correction_link_verified'])
        self.assertIn('historical_correction_not_current_validation', previous['coverage'])
        self.assertEqual(git['last_worker_cycle']['status'], 'success')
        self.assertFalse(git['summary']['scheduled_success_proven'])
        invalid = h.correct_backups(source, log + 'git publication verified: malformed\n', NOW)['data']['git']
        self.assertEqual(invalid['last_verified_correction']['state'], 'unknown')
        self.assertIsNotNone(invalid['last_verified_correction']['collection_error'])

    def test_later_different_failure_does_not_inherit_older_diagnosis(self):
        start, end = '2026-11-08T05:00:00Z', '2026-11-08T05:00:01Z'
        log = failure() + f'[{start}] backup started\n[{end}] backup failed: could not fetch origin/main reason=network_unavailable\n'
        self.assertEqual(h.validation_diagnosis(log, NOW)['state'], 'unknown')
        self.assertFalse(self.project(log + receipt())['correction_link_verified'])

    def test_absent_or_oversize_log_is_unknown(self):
        for log in [None, 'X' * 524289]:
            self.assertEqual(self.project(log)['collection_error'], 'bounded_log_unavailable')

if __name__ == '__main__': unittest.main()
