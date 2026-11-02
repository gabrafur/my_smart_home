"""Candidate internal transport; no CLI, URL input, discovery or MCP registration.
The sealed parent alone supplies credentials and proves the return peer.
"""
import http.client
import ipaddress
import json

class Refused(ValueError):
    pass

def need(value, reason):
    if not value:
        raise Refused(reason)

def decode(raw):
    def unique(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate_response_key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused('nonfinite_response')))

class FixedTransport:
    """Only /auth/token, /flows and /auth/revoke; no redirects or retry.

    `binding` and proof are private parent data, never MCP arguments.
    A live deployment additionally requires sealed source/policy/parent checks.
    """
    def __init__(self, binding, peer_check, connection=http.client.HTTPConnection):
        need(type(binding) is dict and set(binding) == {'host','port','username','password'}, 'fixed_binding_required')
        peer = ipaddress.IPv4Address(binding['host'])
        need(peer.is_private and not peer.is_unspecified and not peer.is_multicast and not peer.is_loopback,
             'private_verified_backend_required')
        need(binding['port'] == 1880 and type(binding['username']) is str and
             0 < len(binding['username']) <= 64 and type(binding['password']) is str and
             0 < len(binding['password']) <= 8192, 'existing_authentication_required')
        need(callable(peer_check), 'sealed_parent_peer_check_required')
        self._binding = dict(binding)
        self._peer_check = peer_check
        self._connection = connection
        self._token = None
        self._scope = None
        self._login_dispatch_attempted = False

    @property
    def login_dispatch_attempted(self):
        # Internal transport evidence, not a caller-controlled authorization.
        return self._login_dispatch_attempted

    def __repr__(self):
        return '<FixedNodeRedTransport private-binding-withheld>'

    def _request(self, method, route, payload=None):
        need((method,route) in {('POST','/auth/token'),('GET','/flows'),('POST','/flows'),('POST','/auth/revoke')},
             'fixed_method_required')
        need(self._peer_check() is True, 'return_peer_identity_unconfirmed')
        headers = {'Node-RED-API-Version':'v2','Accept':'application/json'}
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',',':')).encode()
            need(len(body) <= 16*1024*1024, 'bounded_request_limit')
            headers.update({'Content-Type':'application/json','Content-Length':str(len(body))})
        if self._token:
            headers['Authorization'] = 'Bearer '+self._token
        if route == '/flows' and method == 'POST':
            headers['Node-RED-Deployment-Type'] = 'nodes'
        client = self._connection(str(self._binding['host']), 1880, timeout=12)
        try:
            if method == 'POST' and route == '/auth/token':
                # Set before the first operation that may connect/send bytes.
                # Every later failure is conservatively dispatched/uncertain.
                self._login_dispatch_attempted = True
            client.request(method, route, body=body, headers=headers)
            response = client.getresponse()
            raw = response.read(16*1024*1024+1)
            need(len(raw) <= 16*1024*1024, 'bounded_response_limit')
            # HTTPConnection never follows redirects; error bodies never leave this class.
            need(response.status not in (301,302,303,307,308), 'redirect_refused')
            try:
                data = decode(raw) if raw else None
            except (ValueError, UnicodeError):
                raise Refused('bounded_response_invalid') from None
            return response.status, data
        except (OSError, http.client.HTTPException, TimeoutError):
            # A lost POST can have taken effect. No transparent retry.
            raise Refused('transport_outcome_unknown') from None
        finally:
            client.close()

    def login(self, write=False):
        need(self._token is None, 'session_already_open')
        self._login_dispatch_attempted = False
        status, data = self._request('POST','/auth/token', {
            'client_id':'node-red-admin','grant_type':'password',
            'scope':'*' if write else 'read',
            'username':self._binding['username'],'password':self._binding['password']})
        need(status == 200 and type(data) is dict and type(data.get('access_token')) is str and
             0 < len(data['access_token']) <= 8192, 'authentication_refused')
        self._token = data['access_token']
        self._scope = 'write' if write else 'read'

    def fetch(self):
        need(self._token is not None, 'authenticated_session_required')
        status, data = self._request('GET','/flows')
        need(status == 200 and type(data) is dict and type(data.get('rev')) is str and
             0 < len(data['rev']) <= 256 and type(data.get('flows')) is list and len(data['flows']) <= 10000,
             'configuration_unconfirmed')
        need(set(data) <= {'rev','flows'}, 'unexpected_configuration_fields')
        return data

    def deploy(self, revision, flows):
        need(self._scope == 'write', 'write_session_required')
        need(type(revision) is str and 0 < len(revision) <= 256 and type(flows) is list and
             len(flows) <= 10000, 'mandatory_revision_and_bounded_flows')
        # No credentials property is sent at top level or on any node.
        need(all(type(node) is dict and 'credentials' not in node for node in flows), 'credential_payload_refused')
        status, data = self._request('POST','/flows', {'rev':revision,'flows':flows})
        if status == 409:
            return {'state':'conflict','effect_proven_absent':True}
        if status == 200 and type(data) is dict and type(data.get('rev')) is str and 0 < len(data['rev']) <= 256:
            return {'state':'accepted','rev':data['rev']}
        # Even other errors stay uncertain unless a version-specific no-effect proof exists.
        raise Refused('deploy_outcome_unconfirmed')

    def revoke(self):
        if self._token is None:
            return True
        try:
            status, _ = self._request('POST','/auth/revoke', {'token':self._token})
            return 200 <= status < 300
        except (ValueError,OSError):
            return False
        finally:
            self._token = None
            self._scope = None
