"""Read-only facts from the backup manager already loaded in Home Assistant.

Never open storage files, serialize configuration objects or return a password.
The secret's type/length is used only to report whether it is configured.
"""
from collections.abc import Mapping
from enum import Enum
import re

SCOPE = "ha_saved_backup_profile_v1"


class ProfileUnavailable(RuntimeError):
    """A bounded failure; callers must not serialize the native exception."""


def need(value):
    if not value:
        raise ProfileUnavailable("backup_profile_unavailable")


def identifier(value):
    need(type(value) is str and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value))
    return value


def boolean(value):
    need(type(value) is bool)
    return value


def selection(value):
    if value is None:
        return []
    need(type(value) is list and len(value) <= 128)
    result = []
    for item in value:
        if isinstance(item, Enum):
            item = item.value
        need(type(item) is str and re.fullmatch(r"[A-Za-z0-9_/-]{1,128}", item))
        result.append(item)
    need(len(set(result)) == len(result))
    return result


def retention(value):
    result = {}
    for name in ("copies", "days"):
        count = getattr(value, name)
        need(count is None or type(count) is int and 1 <= count <= 2147483647)
        result[name] = count
    return result


def project_profile(manager, entries):
    """No await: collect one event-loop snapshot of loaded native facts."""
    config = manager.config.data
    create = config.create_backup
    selected = create.agent_ids
    need(type(selected) is list and len(selected) == 1)
    selected_id = identifier(selected[0])
    need(re.fullmatch(r"onedrive\.[A-Za-z0-9_-]{1,119}", selected_id))
    active = manager.backup_agents
    configured = config.agents
    need(isinstance(active, Mapping) and isinstance(configured, Mapping))
    need(selected_id in active and selected_id in configured)
    agent = active[selected_id]
    need(agent.domain == "onedrive" and agent.agent_id == selected_id)
    matching = [entry for entry in entries if entry.domain == "onedrive"
                and entry.disabled_by is None and type(entry.unique_id) is str
                and f"onedrive.{entry.unique_id}" == selected_id]
    need(len(matching) == 1 and isinstance(matching[0].options, Mapping))
    delete_permanently = boolean(matching[0].options.get("delete_permanently", False))
    global_retention = retention(config.retention)
    ids = set(active) | set(configured)
    need(1 <= len(ids) <= 64)
    all_retention = []
    for agent_id in sorted(identifier(value) for value in ids):
        setting = configured.get(agent_id)
        override = setting.retention if setting is not None else None
        effective = global_retention if override is None else retention(override)
        all_retention.append({"agent_id": agent_id, **effective})
    secret = create.password
    need(secret is None or isinstance(secret, str))
    password_configured = secret is not None and len(secret) > 0
    return {
        "schema_version": 1, "scope": SCOPE, "agent_id": selected_id,
        "password_configured": password_configured,
        "provider_protected": boolean(configured[selected_id].protected),
        "include_database": boolean(create.include_database),
        "include_all_addons": boolean(create.include_all_addons),
        "include_addons": selection(create.include_addons),
        "include_folders": selection(create.include_folders),
        "delete_permanently": delete_permanently,
        "native_retention": {
            "all_agents_covered": True,
            "global": global_retention, "agents": all_retention,
        },
    }
