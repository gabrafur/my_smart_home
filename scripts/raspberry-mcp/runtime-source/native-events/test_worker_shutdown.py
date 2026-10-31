"""Cooperative stop without real signals, sockets, credentials or services."""
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import worker


class WorkerShutdownTests(unittest.TestCase):
    def stopped(self, during_request=False):
        handlers = {}
        engine, registry, server, selector = Mock(), Mock(), Mock(), Mock()

        def register(signum, handler):
            handlers[signum] = handler

        def stop():
            handlers[worker.signal.SIGTERM](None, None)

        def select(timeout):
            if during_request:
                return [(None, None)]
            stop()
            return []

        connection = Mock()
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        server.accept.return_value = (connection, None)
        selector.select.side_effect = select
        with ExitStack() as stack:
            for target, name, kwargs in [
                (worker.resource, 'setrlimit', {}),
                (worker.os, 'umask', {}),
                (worker.os, 'geteuid', {'return_value': 1001}),
                (worker.os, 'chmod', {}),
                (worker.os, 'lstat', {'return_value': SimpleNamespace(st_dev=1, st_ino=2)}),
                (worker.os, 'close', {}),
                (worker.os.path, 'lexists', {'return_value': False}),
                (worker, 'instance_lock', {'return_value': 99}),
                (worker.pwd, 'getpwnam', {'return_value': SimpleNamespace(pw_uid=1001)}),
                (worker, 'Registry', {'return_value': registry}),
                (worker, 'Engine', {'return_value': engine}),
                (worker.socket, 'socket', {'return_value': server}),
                (worker.selectors, 'DefaultSelector', {'return_value': selector}),
                (worker.signal, 'signal', {'side_effect': register}),
                (worker.time, 'monotonic', {'return_value': 0}),
            ]:
                stack.enter_context(patch.object(target, name, **kwargs))
            serve = stack.enter_context(patch.object(
                worker, 'serve_connection', side_effect=lambda *args: stop()))
            worker.main()
        engine.tick.assert_not_called()
        registry.db.close.assert_called_once()
        selector.close.assert_called_once()
        server.close.assert_called_once()
        return server, connection, serve

    def test_idle_stop_does_not_start_another_delivery_tick(self):
        server, _, serve = self.stopped()
        server.accept.assert_not_called()
        serve.assert_not_called()

    def test_request_finishes_before_stop_without_a_following_delivery_tick(self):
        server, connection, serve = self.stopped(during_request=True)
        server.accept.assert_called_once()
        serve.assert_called_once()
        connection.__exit__.assert_called_once_with(None, None, None)


if __name__ == '__main__':
    unittest.main()
