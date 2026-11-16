import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime-source' / 'ha-notices'))
import notification_reader as r  # noqa: E402
class P(unittest.TestCase):
    def test_reader_projects_and_validates(self):
        self.assertEqual(r.provenance(None)['source'],'notification_ingress_unknown')
        v={'schema_version':1,'source':'private_operational_spool','basis':'collector_transport_boundary','observed_at':'2026-11-16T12:00:00.000Z'}
        self.assertEqual(r.provenance(v)['source'],'private_operational_spool')
        for bad in ({**v,'source':'forged'},{**v,'basis':'client'},{**v,'extra':1}):
            with self.assertRaises(ValueError): r.provenance(bad)
if __name__=='__main__': unittest.main()
