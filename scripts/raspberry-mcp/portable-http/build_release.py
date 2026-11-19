"""Rewrite release.json from the current files (run after any change, before staging)."""
import hashlib
import json
from pathlib import Path

here = Path(__file__).parent
current = json.loads((here / 'release.json').read_text())
current['files'] = {n: hashlib.sha256((here / n).read_bytes()).hexdigest() for n in current['files']}
(here / 'release.json').write_text(json.dumps(current, indent=2) + '\n')
