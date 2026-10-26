"""Refuse exporting private baseline material into any Git checkout."""
import os
import stat
from pathlib import Path


def require_private_workspace(path):
    workspace = Path(path).resolve(strict=True)
    mode = workspace.stat().st_mode
    if not stat.S_ISDIR(mode) or stat.S_IMODE(mode) != 0o700:
        raise ValueError('private_operator_workspace_required')
    for parent in (workspace, *workspace.parents):
        if os.path.lexists(parent / '.git'):
            raise ValueError('private_operator_workspace_must_be_outside_git')
    return workspace
