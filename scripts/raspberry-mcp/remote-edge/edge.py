"""Authenticated OAuth edge for the Raspberry MCP, meant to sit behind Tailscale Funnel.

Listens on 127.0.0.1 only. Implements the OAuth 2.1 pieces a hosted MCP client needs
(metadata, dynamic client registration, PKCE authorization, token and refresh) and then
forwards a short allowlist of read-only tools to the loopback gateway. The owner proves
identity with a passphrase plus a TOTP code. Nothing here executes commands, reads
Docker or sends credentials anywhere; tokens are stored only as hashes.
"""
import base64
import hashlib
import hmac
import html
import http.client
import json
import os
import re
import resource
import secrets
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

STATE_DIR = Path('/var/lib/raspberry-mcp-edge')
CONFIG_FILE = STATE_DIR / 'config.json'
OWNER_FILE = STATE_DIR / 'owner.json'
STORE_FILE = STATE_DIR / 'state' / 'store.json'
GATEWAY = ('127.0.0.1', 8765)
# A key that only lets the gateway serve the read-only allowlist (the full key is never readable here).
GATEWAY_TOKEN_FILE = Path('/var/lib/raspberry-mcp-edgekey/token')
PORT = 8766
PROTOCOL = '2025-06-18'
REDIRECTS = {'https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'}
# Read-only diagnostics only. Everything else (edits, restarts, Codex tasks, admin
# actions, file reads) is refused here, before the gateway sees it.
ALLOWED_TOOLS = frozenset({
    'service_health', 'service_versions', 'disk_space', 'backup_results', 'log_summary',
    'maintenance_capabilities', 'host_diagnostics', 'service_diagnostics',
    'operation_status', 'events_status', 'admin_action_status',
})
ALLOWED_METHODS = frozenset({'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'})
MAX_BODY = 16384
ACCESS_TTL = 3600
REFRESH_TTL = 30 * 86400
CODE_TTL = 300
MAX_CLIENTS = 100
UNUSED_CLIENT_TTL = 3600
MAX_CONCURRENT = 16
CONNECTION_TIMEOUT = 5
AUTHORIZE_PER_MINUTE = 10
MAX_TOKENS = 50
LOCKOUT_FAILURES = 5  # Second-factor failures after a correct passphrase only.
LOCKOUT_WINDOW = 900


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def totp(secret, step):
    key = base64.b32decode(secret)
    digest = hmac.new(key, struct.pack('>Q', step), 'sha1').digest()
    offset = digest[-1] & 15
    return '%06d' % ((struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000)


def scrypt_hash(passphrase, salt):
    return hashlib.scrypt(passphrase.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


class Limiter:
    """Fixed-window counter per key."""

    def __init__(self, limit, window, clock):
        self.limit, self.window, self.clock, self.hits = limit, window, clock, {}
        self.lock = threading.Lock()

    def allow(self, key):
        with self.lock:
            return self._allow(key)

    def _allow(self, key):
        now = self.clock()
        start, count = self.hits.get(key, (now, 0))
        if now - start >= self.window:
            start, count = now, 0
        if count >= self.limit:
            return False
        self.hits[key] = (start, count + 1)
        return True


class Store:
    """Clients, codes and tokens. Persisted atomically; secrets are kept as hashes."""

    def __init__(self, path, clock=time.time):
        self.path, self.clock, self.lock = path, clock, threading.Lock()
        self.data = {'clients': {}, 'codes': {}, 'access': {}, 'refresh': {}, 'consumed': {}, 'meta': {}}
        try:
            loaded = json.loads(path.read_text()) if path else None
            if isinstance(loaded, dict):
                for key in self.data:
                    if isinstance(loaded.get(key), dict):
                        self.data[key] = loaded[key]
        except (OSError, ValueError):
            pass

    def save(self):
        if self.path is None:
            return
        tmp = self.path.with_name(self.path.name + '.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(self.data, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, self.path)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def prune(self):
        now = self.clock()
        for key in ('codes', 'access', 'refresh', 'consumed'):
            for name, item in list(self.data[key].items()):
                if item['exp'] <= now:
                    del self.data[key][name]
        used = {item['client'] for key in ('access', 'refresh') for item in self.data[key].values()}
        for client_id, client in list(self.data['clients'].items()):
            if client_id not in used and now - client.get('created', 0) > UNUSED_CLIENT_TTL:
                del self.data['clients'][client_id]

    def revoke_client(self, client_id):
        for key in ('access', 'refresh', 'codes'):
            for name, item in list(self.data[key].items()):
                if item['client'] == client_id:
                    del self.data[key][name]

    def evict_unused_client(self):
        """Make room for a registration by dropping the oldest client that never got a token."""
        used = {item['client'] for key in ('access', 'refresh') for item in self.data[key].values()}
        idle = sorted((c.get('created', 0), cid) for cid, c in self.data['clients'].items() if cid not in used)
        if not idle:
            return False
        del self.data['clients'][idle[0][1]]
        return True

    def issue(self, client_id):
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = self.clock()
        self.prune()
        for key in ('access', 'refresh'):  # Bounded: the oldest entries go first.
            items = sorted(self.data[key].items(), key=lambda pair: pair[1]['exp'])
            for name, _ in items[:max(0, len(items) - MAX_TOKENS + 1)]:
                del self.data[key][name]
        self.data['access'][sha(access)] = {'client': client_id, 'exp': now + ACCESS_TTL}
        self.data['refresh'][sha(refresh)] = {'client': client_id, 'exp': now + REFRESH_TTL}
        self.save()
        return {'access_token': access, 'token_type': 'Bearer', 'expires_in': ACCESS_TTL,
                'refresh_token': refresh, 'scope': 'mcp:read'}

    def valid_access(self, token):
        with self.lock:
            item = self.data['access'].get(sha(token))
            return bool(item and item['exp'] > self.clock())


class Edge(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, address, base_url, owner, gateway_token, store, clock=time.time,
                 gateway=GATEWAY):
        if address[0] != '127.0.0.1' or not base_url.startswith('https://') or base_url.endswith('/'):
            raise ValueError('loopback_and_public_https_required')
        self.base_url, self.owner, self.gateway_token = base_url, owner, gateway_token
        self.store, self.clock, self.gateway = store, clock, gateway
        self.failures = []
        self.slots = threading.BoundedSemaphore(MAX_CONCURRENT)
        self.authorize_limit = Limiter(AUTHORIZE_PER_MINUTE, 60, clock)
        self.hash_slots = threading.BoundedSemaphore(2)  # scrypt needs 16 MiB each; keep within MemoryMax.
        self.forward_lock = threading.Lock()
        self.gateway_session = None
        self.register_limit = Limiter(10, 60, clock)
        self.token_limit = Limiter(30, 60, clock)
        self.mcp_limit = Limiter(120, 60, clock)
        super().__init__(address, Handler)

    def handle_error(self, *_args):
        pass

    def process_request(self, request, client_address):
        # Bounded concurrency: a flood of slow peers gets a fast 503, never memory exhaustion.
        if not self.slots.acquire(blocking=False):
            try:
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def locked_out(self):
        now = self.clock()
        self.failures = [t for t in self.failures if now - t < LOCKOUT_WINDOW]
        return len(self.failures) >= LOCKOUT_FAILURES

    def check_owner(self, passphrase, code):
        """Passphrase first (scrypt, outside every lock), then the TOTP code.

        Only second-factor failures after a correct passphrase lock the login, so an
        anonymous caller cannot lock the owner out; the per-minute limit bounds the cost
        of passphrase guessing. Returns "ok", "locked" or "denied".
        """
        owner = self.owner
        if (len(passphrase) > 256 or not isinstance(code, str) or re.fullmatch('[0-9]{6}', code) is None):
            return 'denied'
        with self.hash_slots:
            good = hmac.compare_digest(scrypt_hash(passphrase, bytes.fromhex(owner['salt'])),
                                       bytes.fromhex(owner['hash']))
        if not good:
            return 'denied'
        with self.store.lock:
            if self.locked_out():
                return 'locked'
            step = int(self.clock() // 30)
            last = self.store.data['meta'].get('last_step', 0)
            matched = 0
            for candidate in (step - 1, step, step + 1):
                if hmac.compare_digest(totp(owner['totp'], candidate), code):
                    matched = candidate
            if matched and matched > last:
                self.store.data['meta']['last_step'] = matched  # A code is usable once, even after a restart.
                return 'ok'
            self.failures.append(self.clock())
            return 'denied'


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'MCP-edge/1'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(CONNECTION_TIMEOUT)

    def log_message(self, *_args):
        pass  # Never log URLs, codes, tokens or bodies.

    def send(self, status, body=b'', ctype='application/json', headers=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, separators=(',', ':')).encode()
        self.send_response(status)
        if body:
            self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Strict-Transport-Security', 'max-age=31536000')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com; frame-ancestors 'none'")
        self.send_header('Content-Length', str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def body(self):
        lengths = self.headers.get_all('Content-Length', [])
        if (self.headers.get('Transfer-Encoding') is not None or len(lengths) != 1 or
                not re.fullmatch('[0-9]{1,6}', lengths[0]) or not 0 < int(lengths[0]) <= MAX_BODY):
            return None
        raw = self.rfile.read(int(lengths[0]))
        return raw if len(raw) == int(lengths[0]) else None

    def form(self):
        raw = self.body()
        if raw is None:
            return None
        try:
            values = parse_qs(raw.decode(), keep_blank_values=True, strict_parsing=False)
        except UnicodeError:
            return None
        return {k: v[0] for k, v in values.items() if len(v) == 1}

    # -- routing ---------------------------------------------------------------------
    def do_GET(self):
        path = urlsplit(self.path)
        base = self.server.base_url
        if path.path in ('/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'):
            self.send(200, {'resource': base + '/mcp', 'authorization_servers': [base],
                            'bearer_methods_supported': ['header'], 'scopes_supported': ['mcp:read']})
        elif path.path in ('/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'):
            self.send(200, {'issuer': base, 'authorization_endpoint': base + '/authorize',
                            'token_endpoint': base + '/token', 'registration_endpoint': base + '/register',
                            'response_types_supported': ['code'],
                            'grant_types_supported': ['authorization_code', 'refresh_token'],
                            'code_challenge_methods_supported': ['S256'],
                            'token_endpoint_auth_methods_supported': ['none'],
                            'scopes_supported': ['mcp:read']})
        elif path.path == '/authorize':
            params = {k: v[0] for k, v in parse_qs(path.query).items() if len(v) == 1}
            self.authorize_page(params)
        elif path.path == '/mcp':
            self.send(405, {'error': 'method_not_allowed'}, headers={'Allow': 'POST'})
        else:
            self.send(404, {'error': 'not_found'})

    def do_POST(self):
        route = urlsplit(self.path).path
        if route == '/register':
            self.register()
        elif route == '/authorize':
            self.authorize_submit()
        elif route == '/token':
            self.token()
        elif route == '/mcp':
            self.mcp()
        else:
            self.send(404, {'error': 'not_found'})

    do_DELETE = do_PUT = do_PATCH = lambda self: self.send(405, {'error': 'method_not_allowed'})

    # -- OAuth -----------------------------------------------------------------------
    def register(self):
        server = self.server
        raw = self.body()
        if not server.register_limit.allow('r'):
            return self.send(429, {'error': 'rate_limited'})
        try:
            request = json.loads(raw or b'')
            uris = request['redirect_uris']
            ok = isinstance(uris, list) and uris and all(u in REDIRECTS for u in uris)
        except (ValueError, KeyError, TypeError):
            ok = False
        if not ok:
            return self.send(400, {'error': 'invalid_redirect_uri'})
        with server.store.lock:
            server.store.prune()
            if len(server.store.data['clients']) >= MAX_CLIENTS and not server.store.evict_unused_client():
                return self.send(400, {'error': 'client_limit'})
            client_id = secrets.token_urlsafe(24)
            server.store.data['clients'][client_id] = {'redirect_uris': uris, 'created': server.clock()}
            server.store.save()
        self.send(201, {'client_id': client_id, 'redirect_uris': uris,
                        'token_endpoint_auth_method': 'none',
                        'grant_types': ['authorization_code', 'refresh_token'],
                        'response_types': ['code']})

    def valid_request(self, params):
        clients = self.server.store.data['clients']
        client = clients.get(params.get('client_id', ''))
        return bool(client and params.get('redirect_uri') in client['redirect_uris'] and
                    params.get('response_type') == 'code' and
                    params.get('code_challenge_method') == 'S256' and
                    re.fullmatch('[A-Za-z0-9_-]{43,128}', params.get('code_challenge', '')) and
                    len(params.get('state', '')) <= 512 and
                    params.get('resource', self.server.base_url + '/mcp') == self.server.base_url + '/mcp')

    def authorize_page(self, params, error=''):
        if not self.valid_request(params):
            return self.send(400, b'Pedido de autorizacao invalido.', 'text/plain; charset=utf-8')
        created = self.server.store.data['clients'][params['client_id']].get('created', 0)
        used = any(item['client'] == params['client_id'] for key in ('access', 'refresh')
                   for item in self.server.store.data[key].values())
        age = max(0, int((self.server.clock() - created) // 60))
        notice = 'Cliente registrado ha %d min; %s.' % (
            age, 'ja autorizado antes' if used else 'NUNCA autorizado antes: so continue se voce acabou de adicionar o conector')
        hidden = ''.join('<input type="hidden" name="%s" value="%s">' % (k, html.escape(params.get(k, ''), quote=True))
                         for k in ('client_id', 'redirect_uri', 'response_type', 'code_challenge',
                                   'code_challenge_method', 'state'))
        page = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
                '<title>Autorizar MCP</title><style>body{font:16px system-ui;max-width:26rem;margin:3rem auto;padding:0 1rem}'
                'input,button{font:inherit;width:100%%;padding:.6rem;margin:.4rem 0}.e{color:#b00020}</style>'
                '<h1>Autorizar acesso ao Raspberry</h1><p>Somente leitura de diagnosticos. Confirme que e voce.</p>'
                '<p>%s</p><p class="e">%s</p><form method="post" action="/authorize">%s'
                '<input type="password" name="passphrase" placeholder="Senha" autocomplete="current-password" required>'
                '<input name="code" placeholder="Codigo do autenticador" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required>'
                '<button type="submit">Autorizar</button></form>') % (html.escape(notice), html.escape(error), hidden)
        self.send(200, page.encode(), 'text/html; charset=utf-8')

    def authorize_submit(self):
        server = self.server
        params = self.form()
        if params is None or not self.valid_request(params):
            return self.send(400, b'Pedido de autorizacao invalido.', 'text/plain; charset=utf-8')
        if not server.authorize_limit.allow('a'):
            return self.send(429, b'Muitas tentativas. Aguarde um minuto.', 'text/plain; charset=utf-8')
        verdict = server.check_owner(params.get('passphrase', ''), params.get('code', ''))
        if verdict == 'locked':
            return self.send(429, b'Muitas tentativas. Aguarde 15 minutos.', 'text/plain; charset=utf-8')
        if verdict != 'ok':
            return self.authorize_page(params, 'Senha ou codigo incorretos.')
        code = secrets.token_urlsafe(32)
        with server.store.lock:
            server.store.prune()
            server.store.data['codes'][sha(code)] = {
                'client': params['client_id'], 'redirect_uri': params['redirect_uri'],
                'challenge': params['code_challenge'], 'exp': server.clock() + CODE_TTL}
            server.store.save()
        query = {'code': code}
        if params.get('state'):
            query['state'] = params['state']
        self.send(302, headers={'Location': params['redirect_uri'] + '?' + urlencode(query)})

    def token(self):
        server = self.server
        params = self.form()
        if not server.token_limit.allow('t'):
            return self.send(429, {'error': 'rate_limited'})
        if params is None:
            return self.send(400, {'error': 'invalid_request'})
        store = server.store
        with store.lock:
            store.prune()
            grant = params.get('grant_type')
            if params.get('resource', server.base_url + '/mcp') != server.base_url + '/mcp':
                return self.send(400, {'error': 'invalid_target'})
            if grant == 'authorization_code':
                item = store.data['codes'].pop(sha(params.get('code', '')), None)  # One use.
                verifier = params.get('code_verifier', '')
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
                if (item and item['client'] == params.get('client_id') and
                        item['redirect_uri'] == params.get('redirect_uri') and
                        re.fullmatch('[A-Za-z0-9._~-]{43,128}', verifier) and
                        hmac.compare_digest(item['challenge'], challenge)):
                    return self.send(200, store.issue(item['client']))
            elif grant == 'refresh_token':
                digest = sha(params.get('refresh_token', ''))
                item = store.data['refresh'].pop(digest, None)  # Rotated.
                if item and item['client'] == params.get('client_id'):
                    store.data['consumed'][digest] = {'client': item['client'], 'exp': item['exp']}
                    return self.send(200, store.issue(item['client']))
                replay = store.data['consumed'].get(digest)
                if replay and replay['client'] == params.get('client_id'):
                    store.revoke_client(replay['client'])  # A used refresh token came back: revoke the family.
            else:
                return self.send(400, {'error': 'unsupported_grant_type'})
            store.save()
        self.send(400, {'error': 'invalid_grant'})

    # -- MCP -------------------------------------------------------------------------
    def unauthorized(self):
        challenge = 'Bearer resource_metadata="%s/.well-known/oauth-protected-resource"' % self.server.base_url
        self.send(401, {'error': 'authentication_required'}, headers={'WWW-Authenticate': challenge})

    def rpc_error(self, request_id, code, message):
        self.send(200, {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': code, 'message': message}})

    def mcp(self):
        server = self.server
        values = self.headers.get_all('Authorization', [])
        if len(values) != 1 or not values[0].startswith('Bearer ') or not server.store.valid_access(values[0][7:]):
            return self.unauthorized()
        if not server.mcp_limit.allow('m'):
            return self.send(429, {'error': 'rate_limited'})
        raw = self.body()
        try:
            q = json.loads(raw or b'')
            ok = (isinstance(q, dict) and q.get('jsonrpc') == '2.0' and isinstance(q.get('method'), str)
                  and (('id' not in q and q['method'].startswith('notifications/')) or type(q.get('id')) in (str, int)))
        except ValueError:
            ok = False
        if not ok:
            return self.send(400, {'error': 'invalid_json_rpc'})
        method, rid = q['method'], q.get('id')
        if method not in ALLOWED_METHODS:
            return self.rpc_error(rid, -32601, 'method_not_enabled_remotely')
        if method == 'tools/call':
            name = (q.get('params') or {}).get('name') if isinstance(q.get('params'), dict) else None
            if name not in ALLOWED_TOOLS:
                return self.rpc_error(rid, -32602, 'tool_not_enabled_remotely')
        if method == 'initialize':
            q['params'] = dict(q.get('params') or {}, protocolVersion=PROTOCOL)  # Gateway speaks one version.
        sid = self.headers.get('Mcp-Session-Id')
        if sid is not None and not re.fullmatch('[a-f0-9]{64}', sid):
            return self.send(400, {'error': 'invalid_session'})
        status, reply, new_sid = self.forward(q, sid, method)
        if method == 'tools/list' and status == 200 and isinstance(reply, dict) and 'result' in reply:
            tools = reply['result'].get('tools') if isinstance(reply['result'], dict) else None
            if isinstance(tools, list):
                reply['result']['tools'] = [t for t in tools if isinstance(t, dict) and t.get('name') in ALLOWED_TOOLS]
        self.send(status, b'' if reply is None else reply, headers={'Mcp-Session-Id': new_sid} if new_sid else None)

    def forward(self, q, sid, method):
        """One attempt, never replayed. The gateway allows a single session, so a new
        initialize closes the previous one first."""
        server = self.server
        headers = {'Authorization': 'Bearer ' + server.gateway_token, 'Content-Type': 'application/json',
                   'Accept': 'application/json, text/event-stream'}
        with server.forward_lock:
            try:
                if method == 'initialize' and server.gateway_session:
                    self.gateway_call('DELETE', None, dict(headers, **{'Mcp-Session-Id': server.gateway_session,
                                                                       'MCP-Protocol-Version': PROTOCOL}))
                    server.gateway_session = None
                if sid:
                    headers.update({'Mcp-Session-Id': sid, 'MCP-Protocol-Version': PROTOCOL})
                status, body, new_sid = self.gateway_call('POST', q, headers)
            except (OSError, ValueError, http.client.HTTPException):
                return 504, {'error': 'backend_response_unconfirmed_reconcile_original_operation',
                             'automatic_retry': False}, None
            if method == 'initialize' and status == 200 and new_sid:
                server.gateway_session = new_sid
            return status, body, new_sid

    def gateway_call(self, verb, q, headers):
        connection = http.client.HTTPConnection(*self.server.gateway, timeout=15)
        try:
            connection.request(verb, '/mcp', None if q is None else json.dumps(q), headers)
            response = connection.getresponse()
            raw = response.read(262145)
            if len(raw) > 262144:
                raise ValueError('response_too_large')
            return response.status, (json.loads(raw) if raw else None), response.getheader('Mcp-Session-Id')
        finally:
            connection.close()


def read_private_json(path):
    info = path.lstat()
    if not path.is_file() or info.st_uid != 0 or info.st_mode & 0o222 or info.st_mode & 0o007:
        raise ValueError('unsafe_configuration_file')
    return json.loads(path.read_text())


def main():
    if sys.argv[1:] or os.geteuid() == 0:
        raise ValueError('fixed_unprivileged_entrypoint_required')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    threading.stack_size(256 * 1024)  # Many small threads, not 8 MB of stack each.
    config = read_private_json(CONFIG_FILE)
    owner = read_private_json(OWNER_FILE)
    token = GATEWAY_TOKEN_FILE.read_text().strip()
    if re.fullmatch('[a-f0-9]{64}', token) is None:
        raise ValueError('gateway_token_invalid')
    with Edge(('127.0.0.1', PORT), config['public_base_url'], owner, token, Store(STORE_FILE)) as server:
        server.serve_forever(poll_interval=1)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError):
        sys.stderr.write('mcp_edge_unavailable\n')
        raise SystemExit(1)
