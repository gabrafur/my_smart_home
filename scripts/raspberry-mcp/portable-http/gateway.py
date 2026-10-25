"""Optional loopback MCP transport; forwards to one fixed authenticated Unix scope.

No shell, daemon-control, Docker, credential export, task replay or public bind.
Install separately from the server. Authentication is provisioned by the operator.
"""
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import resource
import secrets
import socket
import stat
import sys
import time

UNIX_SOCKET = '/run/raspberry-mcp/mcp.sock'
TOKEN_FILE = Path('/var/lib/raspberry-mcp-http/token')
PROTOCOL = '2025-06-18'
MAX_REQUEST = 16384
MAX_RESPONSE = 262144
SESSION_TTL = 60
MAX_SESSIONS = 1  # Preserve capacity for the existing tunnel on the Unix listener.


class TransportError(Exception):
    pass


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate_json_key')
        value[key] = item
    return value


def read_token(path=TOKEN_FILE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or
                stat.S_IMODE(before.st_mode) != 0o440 or before.st_nlink != 1 or
                before.st_size != 65):
            raise TransportError('unsafe_authentication_file')
        value = os.read(fd, 66)
        after = os.fstat(fd)
        if ((before.st_size, before.st_mtime_ns, before.st_ino) !=
                (after.st_size, after.st_mtime_ns, after.st_ino) or
                re.fullmatch(b'[a-f0-9]{64}\n', value) is None):
            raise TransportError('unsafe_authentication_file')
        return value[:-1].decode('ascii')
    finally:
        os.close(fd)


class UnixSession:
    def __init__(self):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(12)
        try:
            self.socket.connect(UNIX_SOCKET)
            self.reader = self.socket.makefile('rb')
        except BaseException:
            self.socket.close()
            raise

    def forward(self, message):
        raw = json.dumps(message, separators=(',', ':'), allow_nan=False,
                         ensure_ascii=False).encode()
        if len(raw) > MAX_REQUEST:
            raise TransportError('request_too_large')
        # Exactly one write attempt. A response timeout is never replayed.
        self.socket.sendall(raw + b'\n')
        if 'id' not in message:
            return None
        raw = self.reader.readline(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE or not raw.endswith(b'\n'):
            raise TransportError('backend_response_unconfirmed')
        reply = json.loads(raw)
        if (not isinstance(reply, dict) or reply.get('jsonrpc') != '2.0' or
                reply.get('id') != message['id'] or
                ('result' in reply) == ('error' in reply)):
            raise TransportError('backend_response_unconfirmed')
        return reply

    def close(self):
        self.reader.close()
        self.socket.close()


class Gateway(HTTPServer):
    allow_reuse_address = False

    def __init__(self, address, token, session_factory=UnixSession, clock=time.monotonic):
        if address[0] != '127.0.0.1' or re.fullmatch('[a-f0-9]{64}', token) is None:
            raise TransportError('local_authenticated_transport_required')
        self.token = token
        self.sessions = {}
        self.session_factory = session_factory
        self.clock = clock
        super().__init__(address, Handler)

    def prune(self):
        now = self.clock()
        for sid, (session, touched) in list(self.sessions.items()):
            if now - touched > SESSION_TTL:
                self.drop(sid)

    def drop(self, sid):
        item = self.sessions.pop(sid, None)
        if item:
            item[0].close()

    def server_close(self):
        for sid in list(self.sessions):
            self.drop(sid)
        super().server_close()

    def service_actions(self):
        self.prune()  # Idle sessions must release their backend connection, too.

    def handle_error(self, *_args):
        # A malformed/disconnected peer must not produce a traceback or payload.
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'MCP-local-transport/1'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def log_message(self, *_args):
        # Never emit URLs, auth headers, request data or backend output.
        pass

    def reply(self, status, data=None, sid=None):
        raw = b'' if data is None else json.dumps(data, separators=(',', ':'),
                                                 allow_nan=False).encode()
        self.send_response(status)
        if data is not None:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        if sid:
            self.send_header('Mcp-Session-Id', sid)
        if status == 405:
            self.send_header('Allow', 'POST, DELETE')
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def error(self, status, reason):
        self.reply(status, {'error': reason, 'automatic_retry': False})

    def authorized(self):
        if self.path != '/mcp':
            self.error(404, 'endpoint_not_found')
            return False
        # This native-client bridge accepts no browser Origin. A browser gateway
        # requires separately reviewed origin/TLS/OAuth policy.
        if self.headers.get('Origin') is not None:
            self.error(403, 'browser_origin_not_enabled')
            return False
        values = self.headers.get_all('Authorization', [])
        expected = 'Bearer ' + self.server.token
        if len(values) != 1 or not hmac.compare_digest(values[0].encode(), expected.encode()):
            self.error(401, 'authentication_required')
            return False
        self.server.prune()
        return True

    def session_id(self):
        values = self.headers.get_all('Mcp-Session-Id', [])
        return values[0] if len(values) == 1 else None

    def existing(self):
        sid = self.session_id()
        if not isinstance(sid, str) or re.fullmatch('[a-f0-9]{64}', sid) is None or sid not in self.server.sessions:
            self.error(404, 'session_not_found')
            return None
        if self.headers.get('MCP-Protocol-Version') != PROTOCOL:
            self.error(400, 'unsupported_protocol_version')
            return None
        return sid

    def do_GET(self):
        if self.authorized() and self.existing():
            self.reply(405)  # The underlying server has no SSE notification stream.

    def do_DELETE(self):
        if self.authorized():
            sid = self.existing()
            if sid:
                self.server.drop(sid)
                self.reply(204)  # Closing a transport never cancels a durable task.

    def do_POST(self):
        if not self.authorized():
            return
        if (self.headers.get('Transfer-Encoding') is not None or
                len(self.headers.get_all('Content-Length', [])) != 1 or
                not re.fullmatch('[0-9]{1,6}', self.headers.get('Content-Length', ''))):
            self.error(400, 'invalid_framing')
            return
        size = int(self.headers['Content-Length'])
        if not 1 <= size <= MAX_REQUEST:
            self.error(413, 'request_too_large')
            return
        accept = self.headers.get('Accept', '')
        if (self.headers.get_content_type() != 'application/json' or
                'application/json' not in accept or 'text/event-stream' not in accept):
            self.error(415, 'unsupported_content_negotiation')
            return
        try:
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError()
            q = json.loads(raw, object_pairs_hook=unique_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if (not isinstance(q, dict) or q.get('jsonrpc') != '2.0' or
                    not isinstance(q.get('method'), str) or
                    set(q) - {'jsonrpc', 'id', 'method', 'params'} or
                    'id' in q and (type(q['id']) not in (str, int) or
                                   len(str(q['id'])) > 128)):
                raise ValueError()
        except (ValueError, OSError, UnicodeError):
            self.error(400, 'invalid_json_rpc')
            return
        created = q['method'] == 'initialize'
        if created:
            params = q.get('params')
            if ('id' not in q or self.headers.get('Mcp-Session-Id') is not None or
                    not isinstance(params, dict) or params.get('protocolVersion') != PROTOCOL):
                self.error(400, 'invalid_initialization')
                return
            if len(self.server.sessions) >= MAX_SESSIONS:
                self.error(503, 'session_limit')
                return
            sid = secrets.token_hex(32)
            try:
                session = self.server.session_factory()
            except (OSError, ValueError, TransportError):
                self.error(503, 'backend_unavailable')
                return
            self.server.sessions[sid] = (session, self.server.clock())
        else:
            sid = self.existing()
            if not sid:
                return
            session = self.server.sessions[sid][0]
        try:
            result = session.forward(q)
            if created and ('error' in result or result.get('result', {}).get('protocolVersion') != PROTOCOL):
                self.server.drop(sid)
                self.reply(400, result)
                return
            self.server.sessions[sid] = (session, self.server.clock())
        except (OSError, ValueError, TransportError):
            self.server.drop(sid)
            self.error(504, 'backend_response_unconfirmed_reconcile_original_operation')
            return
        try:
            self.reply(202 if result is None else 200, result, sid)
        except (OSError, ValueError):
            self.server.drop(sid)  # No resend after response loss.


def main():
    if sys.argv[1:] or os.geteuid() == 0:
        raise TransportError('fixed_unprivileged_entrypoint_required')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_AS, (64 * 1048576, 64 * 1048576))
    with Gateway(('127.0.0.1', 8765), read_token()) as server:
        server.serve_forever(poll_interval=1)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TransportError):
        sys.stderr.write('mcp_local_transport_unavailable\n')
        raise SystemExit(1)
