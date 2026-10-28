import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent))
import registry as r
import webhook as w

SECRET='whsec_'+base64.b64encode(b'x'*32).decode()

class Events(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();os.chmod(self.tmp.name,0o700)
        self.t=1800000000.0;self.sent=[]
        self.reg=r.Registry(self.tmp.name,'raspberry_private',approved=True,sender=self.send,clock=lambda:self.t)
        self.params={'name':r.NAME,'arguments':{'project':r.PROJECT,'topics':['ha_notification']},
                     'delivery':{'mode':'webhook','url':'https://callback.example.org/events','secret':SECRET}}
    def tearDown(self):
        self.reg.db.close();self.tmp.cleanup()
    def send(self,url,headers,body):
        data=json.loads(body);self.sent.append((headers,data))
        return 200,json.dumps({'challenge':data.get('challenge')}).encode()
    def add(self,index=0):
        self.t+=1
        return self.reg.enqueue('ha_notification','ha_persistent_notification','added','a'*64,hashlib.sha256(str(index).encode()).hexdigest(),self.t)
    def test_duplicate_survives_restart(self):
        self.reg.subscribe(self.params);first=self.add();self.assertFalse(first['duplicate'])
        self.assertEqual(self.reg.dispatch_one()['state'],'webhook_accepted')
        self.reg.db.close();self.reg=r.Registry(self.tmp.name,'raspberry_private',approved=True,sender=self.send,clock=lambda:self.t)
        self.assertTrue(self.add()['duplicate']);self.t+=601
        self.assertEqual(self.reg.dispatch_one()['state'],'idle');self.assertEqual(len(self.sent),2)
    def test_ambiguous_never_reexecutes(self):
        self.reg.subscribe(self.params);self.add()
        def lost(*args):raise TimeoutError('sensitive response must never appear')
        self.reg.sender=lost
        self.assertEqual(self.reg.dispatch_one()['state'],'uncertain')
        self.t+=601;self.reg.sender=self.send
        self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.assertEqual(self.reg.db.execute('SELECT state FROM dispatch').fetchone()[0],'uncertain')
    def test_declared_scope_and_activation_fail_closed(self):
        self.params['arguments']['project']='/etc'
        with self.assertRaisesRegex(w.Refused,'scope'):self.reg.subscribe(self.params)
        self.assertEqual(self.sent,[])
        self.reg.approved=False
        with self.assertRaisesRegex(w.Refused,'activation'):self.reg.dispatch_one()
    def test_signature_exact_bytes_independent_computation(self):
        body=b'{"message":"ol\\u00e1"}'
        headers=w.signed_headers(SECRET,'evt_a',body,1234,'sub_a')
        digest=hmac.new(b'x'*32,b'evt_a.1234.'+body,hashlib.sha256).digest()
        self.assertEqual(headers['webhook-signature'],'v1,'+base64.b64encode(digest).decode())
        self.assertNotEqual(headers['webhook-signature'],w.signed_headers(SECRET,'evt_a',body+b' ',1234,'sub_a')['webhook-signature'])
    def test_private_and_mixed_dns_refused(self):
        PRIVACY_TEST_FIXTURE_synthetic_addresses=['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:8.8.8.8','224.0.0.1','100.64.0.1','192.0.2.1','2002:0808:0808::1']
        for addr in PRIVACY_TEST_FIXTURE_synthetic_addresses:
            self.assertFalse(w.public_address(addr),addr)
        rows=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',443)),(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]
        with self.assertRaises(w.Refused):w.resolve_public('safe.example',lambda *a,**kw:rows)
    def test_url_rejects_credentials_ports_and_controls(self):
        for url in ['http://example.com','https://a:b@example.com','https://example.com:81','https://example.com/#fragment','https://example.com/\nsecret','https://example.com\\@evil.com']:
            with self.assertRaises(w.Refused,msg=url):w.callback_parts(url)
    def test_callback_must_echo_fresh_challenge(self):
        for sender in [lambda *a:(200,b'{}'),lambda *a:(302,b'{}'),lambda *a:(200,b'not json')]:
            with self.assertRaises(w.Refused):w.verify_callback(self.params['delivery']['url'],SECRET,'s',sender,lambda:self.t)
        self.assertTrue(w.verify_callback(self.params['delivery']['url'],SECRET,'s',self.send,lambda:self.t))
    def test_idempotent_subscription_and_filter_normalization(self):
        a=self.reg.subscribe(self.params);self.params['arguments']['topics'].reverse()
        b=self.reg.subscribe(self.params)
        self.assertEqual(a['id'],b['id']);self.assertEqual(len(self.sent),1)
    def test_refresh_does_not_skip_pending_event(self):
        self.reg.subscribe(self.params);self.add();self.t+=400
        self.reg.subscribe(self.params)
        self.assertEqual(self.reg.dispatch_one()['state'],'webhook_accepted')
    def test_unsubscribe_and_expiration(self):
        self.params['ttlMs']=60000;self.reg.subscribe(self.params);self.add();self.t+=61
        self.assertEqual(self.reg.dispatch_one()['state'],'idle')
        self.reg.subscribe(self.params);self.add(2)
        p={k:v for k,v in self.params.items() if k in ['name','arguments','delivery']};p['delivery']={k:v for k,v in p['delivery'].items() if k!='secret'}
        self.assertEqual(self.reg.unsubscribe(p),{});self.assertEqual(self.reg.unsubscribe(p),{})
        self.assertEqual(self.reg.dispatch_one()['state'],'idle')
    def test_seventh_attempt_permitted_after_six_without_losing_spacing(self):
        self.reg.subscribe(self.params)
        for index in range(6):
            self.t+=601;self.add(index)
            self.assertEqual(self.reg.dispatch_one()['state'],'webhook_accepted')
        self.t+=601;self.add(7)
        self.assertEqual(self.reg.dispatch_one()['state'],'webhook_accepted')
        self.add(8)
        self.assertEqual(self.reg.dispatch_one()['state'],'budget_held')
    def test_unknown_text_never_accepted_into_payload(self):
        with self.assertRaises(w.Refused):self.reg.enqueue('incident','secret password','opened','a'*64,'b'*64,self.t)
        with self.assertRaises(w.Refused):self.reg.enqueue('ha_notification','ha_persistent_notification','added','private message','b'*64,self.t)
    def test_clock_rollback_blocks(self):
        self.reg.subscribe(self.params);self.t-=100
        with self.assertRaisesRegex(w.Refused,'clock'):self.reg.dispatch_one()
    def test_other_principal_cannot_unsubscribe(self):
        self.reg.subscribe(self.params);self.add()
        other=r.Registry(self.tmp.name,'other',approved=True,sender=self.send,clock=lambda:self.t)
        p={'name':r.NAME,'arguments':self.params['arguments'],'delivery':{k:v for k,v in self.params['delivery'].items() if k!='secret'}}
        other.unsubscribe(p);other.db.close()
        self.assertEqual(self.reg.dispatch_one()['state'],'webhook_accepted')
    def test_secret_rotation_signs_both(self):
        self.reg.subscribe(self.params)
        self.params['delivery']['secret']='whsec_'+base64.b64encode(b'y'*32).decode()
        self.reg.subscribe(self.params);self.add();self.reg.dispatch_one()
        self.assertEqual(len(self.sent[-1][0]['webhook-signature'].split()),2)

if __name__=='__main__':unittest.main()
