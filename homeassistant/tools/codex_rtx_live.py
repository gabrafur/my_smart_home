#!/usr/bin/env python3
"""Read only the active Local AI job for the one-second RTX dashboard indicator."""

import json
import urllib.error
import urllib.request


URL = "http://127.0.0.1:8099/local-ai/live"


def main() -> None:
    try:
        with urllib.request.urlopen(URL, timeout=0.8) as response:
            payload = json.load(response)
        local = payload.get("local_ai") if isinstance(payload, dict) else {}
        local = local if isinstance(local, dict) else {}
        job = local.get("current_job")
        job = job if isinstance(job, dict) else {}
        active_jobs = local.get("active_jobs")
        active_jobs = active_jobs if isinstance(active_jobs, list) else []
        sample = job.get("live_gpu")
        sample = sample if isinstance(sample, dict) else {}
        preflight = local.get("preflight")
        preflight = preflight if isinstance(preflight, dict) else {}
        freshness = local.get("freshness")
        freshness = freshness if isinstance(freshness, dict) else {}
        preflight_freshness = freshness.get("preflight")
        preflight_freshness = preflight_freshness if isinstance(preflight_freshness, dict) else {}
        preflight_current = preflight_freshness.get("current") is True
        if job:
            state = "in_use"
        elif local.get("available"):
            state = "available"
        elif not preflight_current:
            state = "stale"
        else:
            state = str(preflight.get("state") or "unavailable").lower().replace("local_ai_", "")
        result = {
            "state": state,
            "task": job.get("task"),
            "model": job.get("model") or preflight.get("model"),
            "started_at": job.get("started_at"),
            "sampled_at": sample.get("at"),
            "gpu_util_percent": sample.get("gpu_util_percent"),
            "vram_mib": sample.get("vram_mib"),
            "vram_total_mib": sample.get("vram_total_mib") or preflight.get("vram_total_mib"),
            "power_watts": sample.get("power_watts"),
            "gpu": preflight.get("gpu"),
            "preflight_checked_at": preflight.get("checked_at"),
            "preflight_age_seconds": preflight_freshness.get("age_seconds"),
            "preflight_current": preflight_current,
            "active_chats": [
                {
                    "chat_id": item.get("chat_id") or "desconhecido",
                    "chat_name": item.get("chat_name"),
                    "task": item.get("task"),
                    "model": item.get("model"),
                    "started_at": item.get("started_at"),
                    "gpu_util_percent": (item.get("live_gpu") or {}).get("gpu_util_percent"),
                    "vram_mib": (item.get("live_gpu") or {}).get("vram_mib"),
                }
                for item in active_jobs if isinstance(item, dict)
            ],
        }
    except (OSError, ValueError, urllib.error.URLError) as error:
        result = {"state": "error", "error": type(error).__name__}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
