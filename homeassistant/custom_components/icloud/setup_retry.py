"""Classify wrapped transport exceptions without interpreting account data."""

from http.client import RemoteDisconnected
from socket import gaierror

from requests.exceptions import ConnectionError as RequestsConnectionError, Timeout


def is_transport_failure(error: BaseException) -> bool:
    """Inspect both exception links; pyicloud wraps failures more than once."""
    pending = [error]
    seen = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, (gaierror, ConnectionError, TimeoutError,
                                RemoteDisconnected, RequestsConnectionError, Timeout)):
            return True
        pending.extend(link for link in (current.__cause__, current.__context__)
                       if link is not None)
    return False
