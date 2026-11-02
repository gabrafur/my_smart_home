import json
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'repair-control'))
import storage_docker_report as d

class ReportTests(unittest.TestCase):
    def test_aggregate_is_closed_and_drops_names(self):
        text='\n'.join(json.dumps({'Type':k,'Size':'1.5MB','private':'private-name'}) for k in d.KINDS)
        r=d.aggregate(text)
        self.assertEqual(len(r),4)
        self.assertTrue(all(x['logical_bytes']==1500000 and x['cleanup_allowed'] is False for x in r))
        self.assertNotIn('private',json.dumps(r))
        with self.assertRaises(ValueError): d.aggregate('{}')
        with self.assertRaises(ValueError): d.size('1.5MB private-name')

    def test_largest_images_are_anonymous_exact_and_deduplicated(self):
        a='sha256:'+'a'*64;b='sha256:'+'b'*64
        ids,count=d.candidates(f'{a}\t1MB\n{a}\t1MB\n{b}\t2MB\n')
        self.assertEqual((ids,count),([b,a],2))
        r=d.largest(f'{a} 123\n{b} 456\n',ids)
        self.assertEqual([x['logical_bytes'] for x in r],[456,123])
        self.assertTrue(all(len(x['item_id'])==24 for x in r))
        self.assertNotIn('sha256:',json.dumps(r))
        with self.assertRaises(ValueError):d.largest(f'{a} 123',ids)
        with self.assertRaises(ValueError):d.candidates('private-name\t1MB')
        with self.assertRaises(ValueError):d.candidates((f'{a}\t1MB\n')*257)

    def test_failure_is_unknown_not_zero_and_largest_failure_retains_aggregate(self):
        def failure(args,deadline):raise ValueError('private backend detail')
        r=d.collect(failure)
        self.assertIsNone(r['data']);self.assertEqual(r['state'],'unknown')
        self.assertNotIn('private backend detail',json.dumps(r))
        def partial(args,deadline):
            if args[0]=='system':return '\n'.join(json.dumps({'Type':k,'Size':'1B'}) for k in d.KINDS)
            raise ValueError('inventory unavailable')
        r=d.collect(partial)
        self.assertEqual(r['state'],'partial');self.assertIsNone(r['collection_error'])
        self.assertEqual(r['largest_collection_error'],'largest_image_measurement_incomplete')
        self.assertEqual(len(r['data']),4)

    def test_commands_are_fixed_and_share_one_deadline(self):
        calls=[];a='sha256:'+'a'*64
        def fixture(args,deadline):
            calls.append((args,deadline))
            if args[0]=='system':return '\n'.join(json.dumps({'Type':k,'Size':'1B'}) for k in d.KINDS)
            if args[1]=='ls':return f'{a}\t1MB'
            return f'{a} 123'
        r=d.collect(fixture)
        self.assertEqual(r['state'],'observed');self.assertEqual(len(calls),3)
        self.assertEqual(len({x[1] for x in calls}),1)
        self.assertEqual(calls[-1][0],['image','inspect','--format','{{.Id}} {{.Size}}',a])


class ProjectionTests(unittest.TestCase):
    def sample(self):
        return {'source':d.SOURCE,'observed_at':'2026-01-01T00:00:00Z','collection_error':None,'state':'observed',
                'data':[{'kind':kind,'logical_bytes':1,'cleanup_allowed':True,'private_name':'secret'} for kind in d.KINDS.values()],
                'largest_observed_images':[{'item_id':'a'*24,'logical_bytes':123,'private':'secret'}],
                'image_inventory_count':1,'largest_collection_error':None}

    def test_original_clock_stale_and_privacy(self):
        import observation as o
        import datetime
        at=datetime.datetime(2026,1,1,tzinfo=datetime.timezone.utc).timestamp()
        r=o.docker_report(self.sample(),at+350)
        self.assertEqual(r['state'],'stale');self.assertEqual(r['age_seconds'],350)
        self.assertEqual(o.docker_report(self.sample(),at+90000)['state'],'stale')
        self.assertNotIn('secret',json.dumps(r));self.assertTrue(all(x['cleanup_allowed'] is False for x in r['data']))
        self.assertEqual(r['largest_observed_images'][0]['logical_bytes'],123)
        self.assertEqual(o.docker_report(self.sample(),at-1)['state'],'unknown')
        bad=self.sample();bad['data'][0]['logical_bytes']=True
        self.assertEqual(o.docker_report(bad,at+1)['state'],'unknown')
        bad=self.sample();bad['data'][0]['kind']='arbitrary-category'
        self.assertEqual(o.docker_report(bad,at+1)['state'],'unknown')
        bad=self.sample();bad['largest_observed_images']=[{'item_id':'private-name','logical_bytes':1}]
        self.assertEqual(o.docker_report(bad,at+1)['state'],'partial')
        self.assertEqual(o.docker_report(bad,at+1)['largest_observed_images'],[])

    def test_missing_failed_source_never_becomes_zero(self):
        import observation as o
        r=o.docker_report(None,1767225601)
        self.assertEqual(r['state'],'unknown');self.assertIsNone(r['data'])
        bad=self.sample();bad['collection_error']='unavailable'
        r=o.docker_report(bad,1767225601)
        self.assertEqual(r['state'],'unknown');self.assertIsNone(r['data'])

    def test_health_projection_preserves_report_age_and_anonymous_consumers(self):
        import observation as o
        import health_summary as h
        raw={'schema_version':1,'observed_at':'2026-01-01T00:05:00Z','categories':{},
             'docker':o.docker_report(self.sample(),1767225900)}
        r=h.storage_health(read=lambda *a:(raw,None),now=1767225950)['docker']
        self.assertEqual(r['source'],d.SOURCE);self.assertEqual(r['state'],'stale')
        self.assertEqual(r['age_seconds'],350)
        self.assertEqual(len(r['data']),4)
        self.assertEqual(r['largest_observed_images'][0]['logical_bytes'],123)
        self.assertNotIn('secret',json.dumps(r))

if __name__=='__main__':unittest.main()
