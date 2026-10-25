"""Review-only MCP Events HTTPS transport. No listener, credentials or autostart.

Standard Webhooks HMAC-SHA256; no external packages. Callers must enforce
subscription ownership and persist dispatch intent before invoking this module.
"""
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import re
import secrets
import signal
import socket
import ssl
import time
from urllib.parse import urlsplit

MAX_BODY = 16384
MAX_REPLY = 4096


class Refused(ValueError):
    pass


def key_bytes(secret):
    if not isinstance(secret, str) or not secret.startswith('whsec_'):
        raise Refused('invalid_signing_key')
    try:
        key = base64.b64decode(secret[6:], validate=True)
    except Exception:
        raise Refused('invalid_signing_key') from None
    if not 24 <= len(key) <= 64:
        raise Refused('invalid_signing_key')
    return key


def callback_parts(url):
    if not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 33 or ord(c) > 126 for c in url):
        raise Refused('invalid_callback')
    try:
        p = urlsplit(url)
        if (p.scheme != 'https' or p.username or p.password or p.fragment
                or p.port not in (None, 443) or not p.hostname
                or '%' in p.hostname or '\\' in url):
            raise ValueError()
    except ValueError:
        raise Refused('invalid_callback') from None
    return p


def public_address(value):
    try:
        a = ipaddress.ip_address(value)
        return (a.is_global and not a.is_multicast and not a.is_reserved
                and not a.is_unspecified and not a.is_loopback
                and not a.is_link_local
                and not (isinstance(a, ipaddress.IPv6Address)
                         and (a.ipv4_mapped or a.sixtofour or a.teredo)))
    except ValueError:
        return False


def resolve_public(host, resolver=socket.getaddrinfo):
    # Reject the whole result if ANY address is unsuitable. No DNS retry or
    # second resolution between validation and connect (DNS rebinding).
    rows = resolver(host, 443, type=socket.SOCK_STREAM)
    if not rows or len(rows) > 32 or any(not public_address(row[4][0]) for row in rows):
        raise Refused('callback_address_blocked')
    family, socktype, protocol, _, sockaddr = rows[0]
    return family, socktype, protocol, sockaddr


class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        family, kind, protocol, target = resolve_public(self.host)
        raw = socket.socket(family, kind, protocol)
        raw.settimeout(self.timeout)
        try:
            raw.connect(target)
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def signed_headers(secret, event_id, body, now, subscription_id, old_secret=None):
    if (not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', event_id)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', subscription_id)
            or not isinstance(body, bytes) or len(body) > MAX_BODY
            or type(now) is not int or now <= 0):
        raise Refused('invalid_envelope')
    signed = event_id.encode() + b'.' + str(now).encode() + b'.' + body
    signatures = []
    for value in [secret] + ([old_secret] if old_secret else []):
        digest = hmac.new(key_bytes(value), signed, hashlib.sha256).digest()
        signatures.append('v1,' + base64.b64encode(digest).decode())
    return {'Content-Type': 'application/json', 'webhook-id': event_id,
            'webhook-timestamp': str(now), 'webhook-signature': ' '.join(signatures),
            'X-MCP-Subscription-Id': subscription_id}


def post(url, headers, body):
    p = callback_parts(url)
    connection = PinnedHTTPS(p.hostname, 443, timeout=5, context=ssl.create_default_context())
    def deadline(signum,frame):
        raise TimeoutError('callback_deadline')
    previous=signal.signal(signal.SIGALRM,deadline)
    signal.setitimer(signal.ITIMER_REAL,10)
    try:
        connection.request('POST', (p.path or '/') + ('?' + p.query if p.query else ''),
                           body=body, headers=headers)
        response = connection.getresponse()
        reply = response.read(MAX_REPLY + 1)
        if len(reply) > MAX_REPLY:
            raise Refused('response_limit')
        # http.client never follows redirects. No response text is logged.
        return response.status, reply
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,previous)
        connection.close()


def verify_callback(url, secret, subscription_id, sender=post, clock=time.time):
    callback_parts(url)
    challenge = secrets.token_urlsafe(32)
    identity = 'verify_' + secrets.token_hex(16)
    body = json.dumps({'type': 'verification', 'challenge': challenge}, separators=(',', ':')).encode()
    started = clock()
    headers = signed_headers(secret, identity, body, int(started), subscription_id)
    try:
        status, reply = sender(url, headers, body)
        echoed = json.loads(reply).get('challenge')
        if (not 200 <= status < 300 or not isinstance(echoed, str)
                or not 0 <= clock() - started <= 10
                or not hmac.compare_digest(echoed.encode(), challenge.encode())):
            raise ValueError()
    except Exception:
        raise Refused('challenge_failed') from None
    return True
