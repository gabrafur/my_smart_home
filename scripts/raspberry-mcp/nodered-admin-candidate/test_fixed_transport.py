import unittest
from fixed_transport import FixedTransport,Refused

class Response:
    def __init__(self,status,body):self.status=status;self.body=body
    def read(self,limit):return self.body[:limit]
class TransportTests(unittest.TestCase):
    def setUp(self):
        self.calls=[];self.responses=[]
        owner=self
        class Connection:
            def __init__(self,*args,**kw):owner.calls.append(('connection',args,kw))
            def request(self,*args,**kw):owner.calls.append(('request',args,kw))
            def getresponse(self):return owner.responses.pop(0)
            def close(self):pass
        self.client=FixedTransport({'host':'192.0.2.8','port':1880,'username':'fixture','password':'FIXTURE_SECRET'},lambda:True,Connection)
    def login(self,write=False):
        self.responses.append(Response(200,b'{"access_token":"FIXTURE_TOKEN"}'));self.client.login(write)
    def test_opaque_revision_minimal_deploy_and_no_credentials(self):
        self.login(True);self.responses.extend([Response(200,b'{"rev":"opaque-2","flows":[]}'),Response(200,b'{"rev":"opaque-3"}')])
        self.assertEqual(self.client.fetch()['rev'],'opaque-2');self.assertEqual(self.client.deploy('opaque-2',[])['rev'],'opaque-3')
        request=self.calls[-1];self.assertEqual(request[2]['headers']['Node-RED-Deployment-Type'],'nodes');self.assertEqual(request[2]['body'],b'{"rev":"opaque-2","flows":[]}')
    def test_read_session_cannot_deploy(self):
        self.login();count=len(self.calls)
        with self.assertRaisesRegex(Refused,'write_session_required'):self.client.deploy('opaque',[])
        self.assertEqual(count,len(self.calls))
    def test_redirect_does_not_forward_authentication(self):
        self.responses.append(Response(302,b'{}'))
        with self.assertRaisesRegex(Refused,'redirect_refused'):self.client.login()
        self.assertEqual(len([c for c in self.calls if c[0]=='request']),1)
    def test_credential_and_missing_revision_rejected_without_post(self):
        self.login(True);count=len(self.calls)
        for rev,flows in [('',[]),('rev',[{'id':'fixture','credentials':{}}])]:
            with self.assertRaises(Refused):self.client.deploy(rev,flows)
        self.assertEqual(count,len(self.calls))
    def test_authentication_not_in_repr_and_closed_session(self):
        self.assertNotIn('FIXTURE_SECRET',repr(self.client));self.login();self.responses.append(Response(200,b'{}'));self.assertTrue(self.client.revoke())
        with self.assertRaises(Refused):self.client.fetch()
    def test_peer_identity_checked_each_request(self):
        self.client._peer_check=lambda:False
        with self.assertRaisesRegex(Refused,'return_peer_identity_unconfirmed'):self.client.login()
        self.assertEqual(self.calls,[])
    def test_conflict_has_no_retry(self):
        self.login(True);self.responses.append(Response(409,b'{}'));self.assertEqual(self.client.deploy('opaque',[])['state'],'conflict');self.assertEqual(len([c for c in self.calls if c[0]=='request']),2)
    def test_peer_refusal_certifies_auth_request_not_dispatched(self):
        self.assertIs(self.client.login_dispatch_attempted, False)
        self.client._peer_check=lambda:False
        with self.assertRaisesRegex(Refused,'return_peer_identity_unconfirmed'):
            self.client.login()
        self.assertIs(self.client.login_dispatch_attempted, False)
        self.assertEqual(self.calls, [])
    def test_request_failure_is_marked_dispatched_before_network_entry(self):
        observed=[]
        client=self.client
        class FailedConnection:
            def __init__(inner,*args,**kwargs):pass
            def request(inner,*args,**kwargs):
                observed.append(client.login_dispatch_attempted)
                raise OSError('synthetic uncertain response')
            def close(inner):pass
        self.client._connection=FailedConnection
        with self.assertRaisesRegex(ValueError,'transport_outcome_unknown'):self.client.login()
        self.assertEqual(observed,[True])
        self.assertIs(self.client.login_dispatch_attempted, True)
if __name__=='__main__':unittest.main()
