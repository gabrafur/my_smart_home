import copy
import unittest
from unittest.mock import patch
import ast
from pathlib import Path
from types import SimpleNamespace

class PriorBroker:
    def handle(self,*args): return {'evidence':{'data':{}}}

legacy=SimpleNamespace(Broker=PriorBroker,health=SimpleNamespace(storage_health=lambda:{},operating_policy_v1=lambda *args:{}))
client=SimpleNamespace(request=lambda *args:None)
catalog=SimpleNamespace(TOOLS=(),catalogue=lambda:{'source':'synthetic_catalogue'})
namespace={'legacy':legacy,'client':client,'catalog':catalog}
source=Path(__file__).with_name('broker.py')
node=next(item for item in ast.parse(source.read_text()).body if isinstance(item,ast.ClassDef) and item.name=='Broker')
exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),namespace)
broker=SimpleNamespace(Broker=namespace['Broker'],legacy=legacy,client=client)

class BrokerProjectionTests(unittest.TestCase):
    def test_full_client_policy_only_on_storage_route_and_input_is_preserved(self):
        observation={'state':'observed','maintenance_admission':{
            'execution_active':True,'client_event_policy':{'state':'approved','policy':{'scope':'synthetic'}}}}
        original=copy.deepcopy(observation)
        instance=object.__new__(broker.Broker)
        with patch.object(broker.client,'request',side_effect=lambda *args:observation), \
             patch.object(broker.legacy.Broker,'handle',side_effect=lambda *args:{'evidence':{'data':{}}}), \
             patch.object(broker.legacy.health,'storage_health',return_value={}), \
             patch.object(broker.legacy.health,'operating_policy_v1',return_value={}):
            direct=instance.handle('storage_metadata_read',{'host':'raspberry'})
            self.assertIn('client_event_policy',direct['storage_maintenance_catalogue']['current_admission'])
            broad=instance.handle('maintenance_capabilities',{'host':'raspberry'})['evidence']['data']
            self.assertNotIn('client_event_policy',broad['storage_maintenance_catalogue']['current_admission'])
            self.assertNotIn('client_event_policy',broad['storage_metadata_refresh']['maintenance_admission'])
            self.assertTrue(broad['storage_maintenance_catalogue']['current_admission']['execution_active'])
            self.assertEqual(observation,original)

if __name__=='__main__':unittest.main()
