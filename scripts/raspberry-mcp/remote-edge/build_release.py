"""Rewrite release.json from the current files (run after any change, before staging)."""
import hashlib
import json
from pathlib import Path

here = Path(__file__).parent
names = ['edge.py', 'edge_admin.py', 'raspberry-mcp-edge.service']
manifest = {'schema_version': 1,
            'files': {n: hashlib.sha256((here / n).read_bytes()).hexdigest() for n in names},
            'loopback_only': True, 'automatic_activation': False, 'changes_backend_authority': False}
(here / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
