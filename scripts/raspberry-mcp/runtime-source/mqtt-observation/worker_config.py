"""Strict Root-owned source-binding configuration; not an MCP path API."""
from pathlib import Path
import json,os,re,stat
from authorization_gate import GateInvalid,pairs,identity
from source_binding import SourcePolicy
PLUGIN_PATH="/mosquitto/metadata/observer.so"
def policy_document(policy,approval):
    if type(policy)is not SourcePolicy or type(approval)is not str or re.fullmatch('[a-f0-9]{64}',approval)is None:
        raise GateInvalid('source_policy_invalid')
    return {'schema_version':1,'container_id':policy.container_id,'binary_sha256':policy.binary_sha256,
      'plugin_sha256':policy.plugin_sha256,'approval_id':approval}
def policy_from_document(value):
    fields={"schema_version","container_id","binary_sha256","plugin_sha256","approval_id"}
    if (type(value)is not dict or set(value)!=fields or type(value["schema_version"])is not int
        or value["schema_version"]!=1 or not all(type(value[k])is str and re.fullmatch("[a-f0-9]{64}",value[k])for k in fields-{"schema_version"})):
        raise GateInvalid("source_policy_invalid")
    policy=SourcePolicy(container_id=value["container_id"],peer_uid=1883,peer_gid=1883,
        binary_sha256=value["binary_sha256"],plugin_sha256=value["plugin_sha256"],
        plugin_path=PLUGIN_PATH,plugin_owner_uid=0)
    return policy,value["approval_id"]
def load_source_policy(path):
    path=Path(path);fd=None
    try:
        parent=path.parent.lstat()
        if path.resolve()!=path or not stat.S_ISDIR(parent.st_mode)or(parent.st_uid,parent.st_gid,stat.S_IMODE(parent.st_mode))!=(0,0,0o700):
            raise GateInvalid("source_policy_parent_invalid")
        fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC)
        before=os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode)or before.st_nlink!=1
            or(before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))!=(0,0,0o600)or before.st_size>4096):
            raise GateInvalid("source_policy_metadata_invalid")
        raw=os.read(fd,4097)
        if identity(os.fstat(fd))!=identity(before):raise GateInvalid("source_policy_changed")
        value=json.loads(raw,object_pairs_hook=pairs)
        return policy_from_document(value)
    except(GateInvalid,OSError):raise
    except(ValueError,TypeError,UnicodeError):raise GateInvalid("source_policy_invalid")from None
    finally:
        if fd is not None:os.close(fd)
