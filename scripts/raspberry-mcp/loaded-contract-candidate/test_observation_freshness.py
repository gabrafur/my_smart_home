import datetime,importlib,importlib.util,json,sys,tempfile,types
from pathlib import Path
import unittest
from unittest.mock import patch
P=Path(__file__).parent
CHECKOUT=P.resolve().parents[2]
package=types.ModuleType('isolated_contract_publisher');package.__path__=[str(CHECKOUT/'homeassistant/custom_components/icloud')];sys.modules[package.__name__]=package
publisher=importlib.import_module(package.__name__+'.loaded_proof')
model=importlib.import_module(package.__name__+'.loaded_contract')
NOW=1800000000.0
class Clock(datetime.datetime):
    @classmethod
    def now(cls,tz=None):return datetime.datetime.fromtimestamp(NOW,datetime.timezone.utc)

class ObservationFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.folder=Path(self.tmp.name)
        q={'schema_version':1,'operation_id':'a'*32,'release_revision':publisher.BUILD_REVISION}
        (self.folder/'.mcp-icloud-activation.json').write_text(json.dumps(q))
        self.enterContext(patch.object(publisher,'datetime',types.SimpleNamespace(datetime=Clock,timezone=datetime.timezone)))
        self.facts={r:{**{k:True for k in model.FIELDS},'collection_error':None}for r in model.ROLES}
    def publish(self,at,native=None):
        return publisher.publish(self.folder,{'synthetic':lambda:None},ha_running=True,phases=['entry_ready'],native_contract=native,observation_at=at)
    def test_executor_delay_preserves_collection_timestamp(self):
        self.assertTrue(self.publish(NOW-8));proof=json.loads((self.folder/'.mcp-icloud-proof.json').read_text())
        observed=datetime.datetime.fromisoformat(proof['observed_at']).timestamp();published=datetime.datetime.fromisoformat(proof['published_at']).timestamp()
        self.assertEqual(observed,NOW-8);self.assertEqual(published,NOW)
    def test_executor_delay_over_sixty_seconds_emits_no_fresh_proof(self):
        self.assertFalse(self.publish(NOW-61));self.assertFalse((self.folder/'.mcp-icloud-proof.json').exists())
    def test_missing_future_or_non_numeric_collection_time_refused(self):
        for value in (None,True,NOW+1,float('nan'),'PRIVATE_SENTINEL'):
            self.assertFalse(self.publish(value))
        self.assertFalse((self.folder/'.mcp-icloud-proof.json').exists())
    def test_native_contract_timestamp_is_never_refreshed_by_serializer(self):
        snap=model.snapshot(model.project(self.facts),None,'d'*64,NOW-5)
        clean=model.validate_snapshot(snap,NOW)
        self.assertEqual(clean['observed_at'],snap['observed_at'])
        self.assertTrue(self.publish(NOW-5,snap));proof=json.loads((self.folder/'.mcp-icloud-proof.json').read_text())
        self.assertEqual(proof['native_contract']['observed_at'],snap['observed_at'])
    def test_fresh_outer_proof_cannot_refresh_stale_nested_contract(self):
        snap=model.snapshot(model.project(self.facts),None,'d'*64,NOW-61)
        self.assertIsNone(model.validate_snapshot(snap,NOW));self.assertTrue(self.publish(NOW,snap))
        self.assertIsNone(json.loads((self.folder/'.mcp-icloud-proof.json').read_text())['native_contract'])
