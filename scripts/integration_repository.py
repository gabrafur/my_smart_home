"""Fixed Marketplace/HACS records; rollback changes only the requested repository.

The caller must stop Home Assistant before restore. No paths come from JSON.
Native storage is authoritative, including invalid or missing native records.
"""
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

REPOSITORIES = {"alandtse/alexa_media_player", "Hyundai-Kia-Connect/kia_uvo"}
STORES = ("marketplace.repositories", "hacs.repositories")
MAX_BYTES = 8 * 1024 * 1024


def read_store(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.geteuid() or info.st_mode & 0o022
                or info.st_size > MAX_BYTES):
            raise ValueError("repository_storage_unsafe")
        raw = os.read(fd, MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("repository_storage_oversize")
    finally:
        os.close(fd)
    value = json.loads(raw)
    if (not isinstance(value, dict) or value.get("key") != path.name
            or type(value.get("version")) is not int or value.get("version") != 1
            or type(value.get("minor_version")) is not int or value.get("minor_version") != 1
            or not isinstance(value.get("data"), dict)):
        raise ValueError("repository_schema_unreviewed")
    return raw, value, info


def find_record(value, repository):
    matches = [(k, v) for k, v in value["data"].items()
               if isinstance(v, dict) and v.get("full_name") == repository]
    if len(matches) != 1:
        raise ValueError("repository_identity_missing_or_ambiguous")
    key, record = matches[0]
    if record.get("installed") is not True or not isinstance(record.get("version_installed"), str):
        raise ValueError("repository_installation_unconfirmed")
    return key, record


def operate(request, base=Path("/config/.storage")):
    repository = request["repository"]
    if repository not in REPOSITORIES:
        raise ValueError("repository_not_reviewed")
    for source in STORES:
        path = base / source
        try:
            raw, value, info = read_store(path)
            break
        except FileNotFoundError:
            continue
    else:
        raise ValueError("repository_storage_missing")
    key, record = find_record(value, repository)
    mode = request["mode"]
    if mode == "read":
        fields = ("full_name", "installed", "installed_commit", "last_commit",
                  "last_version", "version_installed")
        return {**{k: record.get(k) for k in fields},
                "repository_source": "marketplace" if source == STORES[0] else "hacs"}
    if mode == "snapshot":
        return {"source": source, "repository_id": key, "record": record,
                "schema": {k: v for k, v in value.items() if k != "data"},
                "permissions": {"mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}}
    if mode != "restore":
        raise ValueError("repository_operation_not_reviewed")
    before = request["before"]
    target = request["target"]
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", target):
        raise ValueError("repository_target_invalid")
    if (before["source"] != source or before["repository_id"] != key
            or before["schema"] != {k: v for k, v in value.items() if k != "data"}
            or before["record"].get("full_name") != repository
            or before["record"].get("installed") is not True
            or before["permissions"] != {"mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}):
        raise ValueError("repository_restore_identity_changed")
    old = before["record"]["version_installed"]
    if record["version_installed"].lstrip("v") not in (old.lstrip("v"), target.lstrip("v")):
        raise ValueError("repository_changed_by_another_update")
    value["data"][key] = before["record"]
    fd, temporary = tempfile.mkstemp(prefix=".reviewed-repository-", dir=base)
    try:
        with os.fdopen(fd, "w") as out:
            os.fchmod(out.fileno(), stat.S_IMODE(info.st_mode))
            if (os.fstat(out.fileno()).st_uid, os.fstat(out.fileno()).st_gid) != (info.st_uid, info.st_gid):
                raise ValueError("repository_restore_owner_changed")
            json.dump(value, out);out.write("\n");out.flush();os.fsync(out.fileno())
        current_raw, _, current = read_store(path)
        if current_raw != raw or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("repository_changed_during_restore")
        os.replace(temporary, path)
        directory = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
    return {"state": "own_repository_restored", "other_records_preserved": True}


if __name__ == "__main__":
    print(json.dumps(operate(json.load(sys.stdin))))
