import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install-operations.py'))
installer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerContract(unittest.TestCase):
    def test_broker_is_unix_only_and_no_elevation(self):
        unit=installer.unit_text('operator')
        for required in ('PrivateNetwork=yes','RestrictAddressFamilies=AF_UNIX','NoNewPrivileges=yes','ProtectSystem=strict','CapabilityBoundingSet=','MemoryMax=96M','TasksMax=8','RuntimeMaxSec=55','ProtectHome=yes'):
            self.assertIn(required,unit)
        self.assertNotIn('User=root',unit)
        self.assertIn('SocketMode=0600',installer.SOCKET)
        self.assertIn('SocketUser=raspberry-mcp',installer.SOCKET)
        self.assertNotIn('0.0.0.0',installer.SOCKET)
    def test_existing_read_server_and_code_pinned(self):
        self.assertEqual(set(installer.PINNED),{'operations.py','expanded-server.mjs','core.mjs','server.mjs'})
        self.assertTrue(all(len(x)==64 for x in installer.PINNED.values()))
        self.assertIn('ExecStart=/usr/bin/node /app/expanded-server.mjs',installer.OVERRIDE)

if __name__=='__main__':unittest.main()
