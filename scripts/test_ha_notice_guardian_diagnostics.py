"""Exercise public source with synthetic diagnostic fixtures only."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).parent
READER = HERE / 'raspberry-mcp/runtime-source/ha-notices/content_reader.py'
CATALOG = json.loads(READER.with_name('diagnostic_templates.json').read_text())


def load_reader():
    original = Path.read_text

    def candidate_catalog(path, *args, **kwargs):
        if path.name == 'operational_notice_templates.json':
            return '{"schema_version":1,"fragments":{}}'
        return original(path, *args, **kwargs)

    spec = importlib.util.spec_from_file_location('guardian_candidate_reader', READER)
    module = importlib.util.module_from_spec(spec)
    with patch.object(Path, 'read_text', candidate_catalog):
        spec.loader.exec_module(module)
    return module


reader = load_reader()


def diagnostic():
    return {'schema_version': 1, 'source': 'host_memory_guardian_request_unrecognized',
            'reason': 'execution_failed', 'exit_code': 143, 'signal': None, 'elapsed_ms': 17000}


class GuardianReaderTests(unittest.TestCase):
    def test_exact_structured_diagnostic_and_backward_compatibility(self):
        value = {'exception_type': None, 'message_codes': [], 'reason_codes': [],
                 'stack': [], 'causes': [], 'redacted_fields': [], 'collection_error': None}
        self.assertNotIn('guardian_request', reader.error(value))
        value['guardian_request'] = diagnostic()
        self.assertEqual(reader.error(value)['guardian_request'], diagnostic())

    def test_malicious_typed_fields_and_extra_payload_rejected(self):
        for key, bad in [('reason', 'token=fixture-secret'), ('exit_code', True),
                         ('exit_code', 9007199254740992), ('signal', 'SIGSECRET'),
                         ('elapsed_ms', -1), ('elapsed_ms', '22179'), ('schema_version', True)]:
            value = diagnostic()
            value[key] = bad
            with self.assertRaises(ValueError):
                reader.guardian_request(value)
        value = diagnostic()
        value['raw_payload'] = 'token=fixture-secret'
        with self.assertRaises(ValueError):
            reader.guardian_request(value)

    def test_closed_context_map_contains_only_requested_delta(self):
        self.assertEqual(CATALOG['context_flows']['host_memory_guardian_tab'], 'guardiao_memoria_host')
        self.assertEqual(CATALOG['context_nodes']['host_memory_guardian_request_invalid'], 'Resposta da ponte inválida')
        self.assertEqual(CATALOG['context_flows']['storage_health_tab'], 'storage_health')
        self.assertEqual(CATALOG['context_nodes']['storage_maintenance_complete'], 'Validar termino / cooldown')
        result = reader.context({'flow': 'host_memory_guardian_tab', 'node': 'host_memory_guardian_request_invalid'})
        self.assertEqual(result['flow']['name'], 'guardiao_memoria_host')
        self.assertEqual(result['node']['name'], 'Resposta da ponte inválida')


if __name__ == '__main__':
    unittest.main()
