import copy
import importlib.util
import json
from pathlib import Path
import unittest
s=importlib.util.spec_from_file_location('health_storage',Path(__file__).with_name('health_summary.py'))
h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
AT='2026-10-30T12:00:00+00:00'
NOW=h.stamp(AT)+10

def fixture():
    row={'observed_at':AT,'data':{'logical_bytes_lower_bound':12,'allocated_bytes_lower_bound':16,
         'metadata_entries':2,'inaccessible_or_missing_entries':0,'complete':True,
         'largest_observed_files':[{'item_id':'a'*24,'logical_bytes':12,'private_name':'secret'}]}}
    return {'schema_version':1,'observed_at':AT,'categories':{'logs':row},
            'filesystem':{'observed_at':AT,'data':{'total_bytes':100,'available_bytes':30,
                          'free_bytes_including_reserve':35,'used_bytes':65}},
            'legacy_report':{'observed_at':'2026-10-29T12:00:00+00:00','data':{
                'total_bytes':100,'available_bytes':50,'logical_bytes_by_category':{'docker':99,'private_name':'secret'}}},
            'docker':{'data':None},'private_name':'secret'}

class ProjectionTests(unittest.TestCase):
    def test_safe_projection_preserves_source_age_and_hides_names(self):
        out=h.storage_health(lambda *_:(fixture(),None),NOW)
        self.assertEqual(out['age_seconds'],10)
        self.assertEqual(out['legacy_report']['age_seconds'],86410)
        self.assertEqual(out['legacy_report']['state'],'stale')
        self.assertNotIn('secret',json.dumps(out))
        self.assertEqual(out['categories']['logs']['data']['logical_bytes_lower_bound'],12)
        self.assertFalse(out['cleanup_enabled'])

    def test_partial_and_boolean_numbers_never_become_complete_zero_evidence(self):
        v=fixture();v['categories']['logs']['data'].update(complete=False,logical_bytes_lower_bound=True)
        out=h.storage_health(lambda *_:(v,None),NOW)['categories']['logs']
        self.assertEqual(out['state'],'partial');self.assertIsNone(out['data']['logical_bytes_lower_bound'])
        self.assertEqual(out['collection_error'],'bounded_or_incomplete_scan')

    def test_bad_nested_objects_and_missing_report_do_not_break_capabilities(self):
        for key in ['categories','legacy_report','deleted_open','docker','growth']:
            for value in [None,[],{'data':None}]:
                with self.subTest(key=key,value=value):
                    v=fixture();v[key]=value;h.storage_health(lambda *_:(v,None),NOW)
        self.assertEqual(h.storage_health(lambda *_:(None,'source_missing'),NOW)['state'],'unknown')
        v=fixture();v['schema_version']=True
        self.assertEqual(h.storage_health(lambda *_:(v,None),NOW)['state'],'unknown')

    def test_stale_source_does_not_refresh_when_the_tool_is_read(self):
        out=h.storage_health(lambda *_:(fixture(),None),NOW+400)
        self.assertEqual(out['state'],'stale');self.assertEqual(out['age_seconds'],410)
        v=fixture();v['observed_at']='2027-01-01T00:00:00Z'
        self.assertEqual(h.storage_health(lambda *_:(v,None),NOW)['state'],'unknown')

if __name__=='__main__':unittest.main()
