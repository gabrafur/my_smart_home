#!/usr/bin/env python3
"""Collect Raspberry Pi host health metrics for Home Assistant."""

from __future__ import annotations

import fcntl
import json
import os
import socket
import struct
import subprocess
import time
from pathlib import Path


STATE_PATH = Path("/config/.storage/raspberry_pi_health_state.json")
PROC_ROOT = Path(os.environ.get("PI_HEALTH_PROC_ROOT", "/host/proc"))
SYS_ROOT = Path(os.environ.get("PI_HEALTH_SYS_ROOT", "/host/sys"))
OS_RELEASE_PATHS = (
    Path(os.environ.get("PI_HEALTH_OS_RELEASE", "/host/etc/os-release")),
    Path("/etc/os-release"),
)
CONFIG_PATH = Path(os.environ.get("PI_HEALTH_CONFIG_PATH", "/config"))
STORAGE_MAINTENANCE_STATUS_PATH = Path(
    os.environ.get("PI_STORAGE_MAINTENANCE_STATUS_PATH", str(CONFIG_PATH / "storage-maintenance-status.json"))
)


def first_existing(path: Path) -> Path:
    if path.exists():
        return path
    if str(path).startswith("/host/"):
        fallback = Path(str(path).replace("/host", "", 1))
        if fallback.exists():
            return fallback
    return path


def read_text(path: Path, default: str | None = None) -> str | None:
    try:
        return first_existing(path).read_text(encoding="utf-8", errors="ignore").strip("\x00\n ")
    except OSError:
        return default


def read_int(path: Path) -> int | None:
    value = read_text(path)
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError:
        return None


def parse_os_release() -> str | None:
    for path in OS_RELEASE_PATHS:
        text = read_text(path)
        if not text:
            continue
        data: dict[str, str] = {}
        for line in text.splitlines():
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            data[key] = value.strip().strip('"')
        return data.get("PRETTY_NAME") or data.get("NAME")
    return None


def raspberry_pi_model() -> str | None:
    model = read_text(PROC_ROOT / "device-tree/model") or read_text(Path("/proc/device-tree/model"))
    if model:
        return model
    cpuinfo = read_text(PROC_ROOT / "cpuinfo") or read_text(Path("/proc/cpuinfo"), "")
    for line in cpuinfo.splitlines():
        if line.startswith("Model"):
            return line.split(":", 1)[1].strip()
    return None


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(state), encoding="utf-8")
    except OSError:
        pass


def parse_cpu_stat() -> tuple[int, int] | None:
    text = read_text(PROC_ROOT / "stat")
    if not text:
        return None
    first = text.splitlines()[0].split()
    if not first or first[0] != "cpu":
        return None
    values = [int(part) for part in first[1:]]
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    total = sum(values)
    return total, idle


def cpu_percent(previous: dict, now: float) -> float | None:
    current = parse_cpu_stat()
    if current is None:
        return None
    total, idle = current
    previous_total = previous.get("cpu_total")
    previous_idle = previous.get("cpu_idle")
    if previous_total is None or previous_idle is None:
        time.sleep(0.25)
        second = parse_cpu_stat()
        if second is None:
            return None
        total2, idle2 = second
        delta_total = total2 - total
        delta_idle = idle2 - idle
        previous["cpu_total"] = total2
        previous["cpu_idle"] = idle2
        previous["sample_time"] = now
    else:
        delta_total = total - int(previous_total)
        delta_idle = idle - int(previous_idle)
        previous["cpu_total"] = total
        previous["cpu_idle"] = idle
        previous["sample_time"] = now
    if delta_total <= 0:
        return None
    return round(max(0.0, min(100.0, (1.0 - (delta_idle / delta_total)) * 100.0)), 1)


def parse_meminfo() -> dict[str, int]:
    text = read_text(PROC_ROOT / "meminfo", "")
    data: dict[str, int] = {}
    for line in text.splitlines():
        key, value = line.split(":", 1)
        parts = value.strip().split()
        if parts:
            data[key] = int(parts[0])
    return data


def memory_metrics() -> dict:
    mem = parse_meminfo()
    total = mem.get("MemTotal")
    available = mem.get("MemAvailable")
    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)
    result: dict[str, float | int | None] = {
        "memory_total_mb": round(total / 1024, 1) if total else None,
        "memory_available_mb": round(available / 1024, 1) if available is not None else None,
        "memory_used_mb": round((total - available) / 1024, 1) if total and available is not None else None,
        "memory_used_percent": round(((total - available) / total) * 100, 1) if total and available is not None else None,
        "swap_total_mb": round(swap_total / 1024, 1) if swap_total else 0,
        "swap_used_mb": round((swap_total - swap_free) / 1024, 1) if swap_total else 0,
        "swap_used_percent": round(((swap_total - swap_free) / swap_total) * 100, 1) if swap_total else 0,
    }
    return result


def disk_metrics() -> dict:
    try:
        stats = os.statvfs(CONFIG_PATH)
    except OSError:
        return {
            "disk_path": str(CONFIG_PATH),
            "disk_total_gb": None,
            "disk_used_gb": None,
            "disk_free_gb": None,
            "disk_used_percent": None,
            "disk_inodes_total": None,
            "disk_inodes_free": None,
            "disk_inodes_used_percent": None,
        }
    total = stats.f_frsize * stats.f_blocks
    free = stats.f_frsize * stats.f_bavail
    used = total - free
    inode_total = stats.f_files
    inode_free = stats.f_favail
    inode_used = inode_total - inode_free
    gib = 1024**3
    return {
        "disk_path": str(CONFIG_PATH),
        "disk_total_gb": round(total / gib, 2),
        "disk_used_gb": round(used / gib, 2),
        "disk_free_gb": round(free / gib, 2),
        "disk_used_percent": round((used / total) * 100, 1) if total else None,
        "disk_inodes_total": inode_total or None,
        "disk_inodes_free": inode_free if inode_total else None,
        "disk_inodes_used_percent": round((inode_used / inode_total) * 100, 1) if inode_total else None,
    }


def storage_maintenance_metrics() -> dict:
    """Read the host-written, non-sensitive maintenance status if available."""
    keys = (
        "filesystem_total_bytes",
        "filesystem_used_bytes",
        "filesystem_free_bytes",
        "filesystem_used_percent",
        "inodes_total",
        "inodes_used",
        "docker_logical_bytes",
        "docker_images_logical_bytes",
        "docker_unused_tagged_logical_bytes",
        "docker_unused_untagged_logical_bytes",
        "known_logs_bytes",
        "repository_bytes",
        "vscode_server_logical_bytes",
        "cursor_server_logical_bytes",
        "npm_cache_logical_bytes",
        "allowlisted_user_caches_logical_bytes",
        "pm2_logs_logical_bytes",
        "home_assistant_recorder_logical_bytes",
        "home_assistant_backups_logical_bytes",
        "deleted_open_bytes",
        "deleted_open_count",
        "last_reclaimed_bytes",
        "last_filesystem_net_reclaimed_bytes",
    )
    metrics: dict[str, int | float | str | None] = {
        f"storage_maintenance_{key}": None for key in keys
    }
    metrics.update(
        {
            "storage_maintenance_last_at": None,
            "storage_maintenance_phase2_last_at": None,
            "storage_maintenance_last_result": None,
            "storage_maintenance_deleted_open_scan_complete": None,
            "storage_maintenance_last_reclaimed_by_category": None,
        }
    )
    try:
        payload = json.loads(STORAGE_MAINTENANCE_STATUS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return metrics
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        return metrics
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            metrics[f"storage_maintenance_{key}"] = value
    last_at = payload.get("last_maintenance_at")
    if isinstance(last_at, str) and last_at:
        metrics["storage_maintenance_last_at"] = last_at
    phase2_last_at = payload.get("phase2_last_maintenance_at")
    if isinstance(phase2_last_at, str) and phase2_last_at:
        metrics["storage_maintenance_phase2_last_at"] = phase2_last_at
    deleted_scan_complete = payload.get("deleted_open_scan_complete")
    if isinstance(deleted_scan_complete, bool):
        metrics["storage_maintenance_deleted_open_scan_complete"] = deleted_scan_complete
    allowed_categories = {
        "report",
        "logs",
        "pm2-logs",
        "journald",
        "apt-cache",
        "temporary-files",
        "docker-images",
        "docker-build-cache",
        "docker-tagged-images",
        "stopped-containers",
        "git",
        "project-artifacts",
        "developer-tools",
        "user-caches",
        "npm-cache",
        "python-cache",
        "vscode-versions",
        "vscode-cache",
        "deleted-open-files",
        "home-assistant-recorder",
        "home-assistant-backups",
    }
    reclaimed = payload.get("last_reclaimed_by_category")
    if isinstance(reclaimed, dict):
        filtered = {
            key: value
            for key, value in reclaimed.items()
            if key in allowed_categories
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
            and value >= 0
        }
        metrics["storage_maintenance_last_reclaimed_by_category"] = filtered
    last_result = payload.get("last_result")
    if last_result in {"success", "partial", "failed"}:
        metrics["storage_maintenance_last_result"] = last_result
    return metrics


def load_metrics() -> dict:
    text = read_text(PROC_ROOT / "loadavg")
    if not text:
        return {"load_1m": None, "load_5m": None, "load_15m": None}
    parts = text.split()
    return {
        "load_1m": float(parts[0]),
        "load_5m": float(parts[1]),
        "load_15m": float(parts[2]),
    }


def temperature_c() -> float | None:
    thermal_root = first_existing(SYS_ROOT / "class/thermal")
    try:
        zones = sorted(thermal_root.glob("thermal_zone*/temp"))
    except OSError:
        zones = []
    for path in zones:
        value = read_int(path)
        if value is not None and value > 0:
            return round(value / 1000, 1)
    value = read_int(SYS_ROOT / "class/hwmon/hwmon0/temp1_input")
    return round(value / 1000, 1) if value is not None else None


def cpu_frequency_mhz() -> float | None:
    paths = (
        SYS_ROOT / "devices/system/cpu/cpu0/cpufreq/scaling_cur_freq",
        SYS_ROOT / "devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq",
    )
    for path in paths:
        value = read_int(path)
        if value is not None and value > 0:
            return round(value / 1000, 0)

    clock = run_command(["vcgencmd", "measure_clock", "arm"])
    if clock.get("ok") and "=" in clock["stdout"]:
        try:
            return round(int(clock["stdout"].split("=", 1)[1]) / 1_000_000, 0)
        except ValueError:
            return None
    return None


def default_interface() -> str | None:
    text = read_text(PROC_ROOT / "net/route", "")
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) > 2 and parts[1] == "00000000":
            return parts[0]
    for candidate in ("eth0", "wlan0", "enp0s3"):
        if first_existing(SYS_ROOT / "class/net" / candidate).exists():
            return candidate
    return None


def interface_ip(interface: str | None) -> str | None:
    if not interface:
        return None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    except OSError:
        return None
    try:
        packed = struct.pack("256s", interface[:15].encode("utf-8"))
        result = fcntl.ioctl(sock.fileno(), 0x8915, packed)
        return socket.inet_ntoa(result[20:24])
    except OSError:
        return None
    finally:
        sock.close()


def network_metrics(previous: dict, now: float) -> dict:
    interface = default_interface()
    base = SYS_ROOT / "class/net" / interface / "statistics" if interface else None
    operstate = read_text(SYS_ROOT / "class/net" / interface / "operstate") if interface else None
    rx = read_int(base / "rx_bytes") if base else None
    tx = read_int(base / "tx_bytes") if base else None
    elapsed = max(1.0, now - float(previous.get("network_sample_time", now)))
    rx_rate = None
    tx_rate = None
    if rx is not None and previous.get("network_rx_bytes") is not None:
        rx_rate = round(max(0, rx - int(previous["network_rx_bytes"])) / elapsed, 1)
    if tx is not None and previous.get("network_tx_bytes") is not None:
        tx_rate = round(max(0, tx - int(previous["network_tx_bytes"])) / elapsed, 1)
    if rx is not None:
        previous["network_rx_bytes"] = rx
    if tx is not None:
        previous["network_tx_bytes"] = tx
    previous["network_sample_time"] = now
    return {
        "network_interface": interface,
        "network_operstate": operstate,
        "network_ip": interface_ip(interface),
        "network_rx_mb": round(rx / 1024**2, 1) if rx is not None else None,
        "network_tx_mb": round(tx / 1024**2, 1) if tx is not None else None,
        "network_rx_kbps": round((rx_rate * 8) / 1000, 1) if rx_rate is not None else None,
        "network_tx_kbps": round((tx_rate * 8) / 1000, 1) if tx_rate is not None else None,
    }


def run_command(command: list[str]) -> dict[str, str | bool | int | None]:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except FileNotFoundError as exc:
        stderr = str(exc)
        if command and command[0] == "vcgencmd" and Path("/usr/bin/vcgencmd").exists():
            stderr = "vcgencmd is mounted, but its runtime or firmware device is not available in the container"
        return {"ok": False, "stdout": "", "stderr": stderr, "returncode": None}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "stdout": "", "stderr": str(exc), "returncode": None}
    return {
        "ok": completed.returncode == 0,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
        "returncode": completed.returncode,
    }


def throttling_metrics() -> dict:
    result = run_command(["vcgencmd", "get_throttled"])
    metrics: dict[str, bool | str | int | None] = {
        "vcgencmd_available": bool(result["ok"]),
        "vcgencmd_error": None if result["ok"] else str(result["stderr"] or result["stdout"] or "unavailable"),
        "throttled_hex": None,
        "throttled_value": None,
        "under_voltage_now": False,
        "frequency_capped_now": False,
        "throttled_now": False,
        "soft_temperature_limit_now": False,
        "under_voltage_occurred": False,
        "frequency_capped_occurred": False,
        "throttling_occurred": False,
        "soft_temperature_limit_occurred": False,
    }
    if not result["ok"] or "=" not in str(result["stdout"]):
        return metrics

    raw = str(result["stdout"]).split("=", 1)[1].strip()
    try:
        value = int(raw, 16)
    except ValueError:
        return metrics

    metrics.update(
        {
            "throttled_hex": raw,
            "throttled_value": value,
            "under_voltage_now": bool(value & (1 << 0)),
            "frequency_capped_now": bool(value & (1 << 1)),
            "throttled_now": bool(value & (1 << 2)),
            "soft_temperature_limit_now": bool(value & (1 << 3)),
            "under_voltage_occurred": bool(value & (1 << 16)),
            "frequency_capped_occurred": bool(value & (1 << 17)),
            "throttling_occurred": bool(value & (1 << 18)),
            "soft_temperature_limit_occurred": bool(value & (1 << 19)),
        }
    )
    return metrics


def uptime_metrics() -> dict:
    uptime_text = read_text(PROC_ROOT / "uptime")
    if not uptime_text:
        return {"uptime_seconds": None, "last_boot": None}
    uptime_seconds = float(uptime_text.split()[0])
    last_boot = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - uptime_seconds))
    return {"uptime_seconds": round(uptime_seconds), "last_boot": last_boot}


def health_from(metrics: dict) -> tuple[str, list[str]]:
    issues: list[str] = []
    critical = False
    warning = False

    def above(key: str, warn: float, crit: float, label: str) -> None:
        nonlocal critical, warning
        value = metrics.get(key)
        if not isinstance(value, (int, float)):
            return
        if value >= crit:
            critical = True
            issues.append(f"{label} critical ({value})")
        elif value >= warn:
            warning = True
            issues.append(f"{label} warning ({value})")

    above("cpu_temperature_c", 75, 82, "temperature")
    above("cpu_usage_percent", 85, 95, "cpu")
    above("memory_used_percent", 80, 90, "memory")
    above("swap_used_percent", 25, 50, "swap")
    above("disk_used_percent", 70, 90, "storage")

    cores = metrics.get("cpu_cores") or 4
    load_5m = metrics.get("load_5m")
    if isinstance(load_5m, (int, float)):
        if load_5m >= cores * 2:
            critical = True
            issues.append(f"load critical ({load_5m})")
        elif load_5m >= cores * 1.2:
            warning = True
            issues.append(f"load warning ({load_5m})")

    if metrics.get("under_voltage_now") or metrics.get("throttled_now") or metrics.get("soft_temperature_limit_now"):
        critical = True
        issues.append("active Raspberry Pi throttling/power condition")
    elif metrics.get("under_voltage_occurred") or metrics.get("throttling_occurred") or metrics.get("soft_temperature_limit_occurred"):
        warning = True
        issues.append("Raspberry Pi throttling/power event occurred since boot")

    if metrics.get("network_operstate") not in (None, "up", "unknown"):
        warning = True
        issues.append(f"network {metrics.get('network_interface')} is {metrics.get('network_operstate')}")

    if critical:
        return "critical", issues
    if warning:
        return "warning", issues
    return "normal", issues


def main() -> int:
    now = time.time()
    previous = load_state()
    metrics: dict = {
        "hostname": socket.gethostname(),
        "model": raspberry_pi_model(),
        "os": parse_os_release(),
        "installation": "Home Assistant Core em Docker",
        "collected_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(now)),
        "cpu_cores": os.cpu_count(),
        "cpu_temperature_c": temperature_c(),
        "cpu_frequency_mhz": cpu_frequency_mhz(),
    }
    metrics.update(load_metrics())
    metrics.update(memory_metrics())
    metrics.update(disk_metrics())
    metrics.update(storage_maintenance_metrics())
    metrics.update(network_metrics(previous, now))
    metrics.update(throttling_metrics())
    metrics.update(uptime_metrics())
    metrics["cpu_usage_percent"] = cpu_percent(previous, now)
    health, issues = health_from(metrics)
    metrics["health"] = health
    metrics["issues"] = "; ".join(issues) if issues else "none"
    save_state(previous)
    print(json.dumps(metrics, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
