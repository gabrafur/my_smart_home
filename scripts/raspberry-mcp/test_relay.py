import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('relay', Path(__file__).with_name('relay.py'))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

class RelayTests(unittest.TestCase):
    def test_idle_session_remains_open_until_peer_eof(self):
        connection = MagicMock()
        connection.recv.return_value = b''
        selector = MagicMock()
        selector.select.side_effect = [[], [(SimpleNamespace(fileobj=connection), 1)]]
        with patch.object(relay.sys, 'argv', ['relay.py']), patch.dict(relay.os.environ, {}, clear=True), \
             patch.object(relay.socket, 'socket') as socket, patch.object(relay.selectors, 'DefaultSelector') as factory:
            socket.return_value.__enter__.return_value = connection
            factory.return_value.__enter__.return_value = selector
            relay.main()
        self.assertEqual(selector.select.call_count, 2)
        connection.connect.assert_called_once_with('/run/raspberry-mcp/mcp.sock')
        connection.settimeout.assert_called_once_with(120)
        connection.recv.assert_called_once_with(16384)

    def test_arguments_cannot_change_target(self):
        with patch.object(relay.sys, 'argv', ['relay.py', 'other-host']), patch.object(relay.socket, 'socket') as socket:
            with self.assertRaises(SystemExit):
                relay.main()
            socket.assert_not_called()

if __name__ == '__main__':
    unittest.main()
