#!/usr/bin/env python3
"""Offline benchmark; inputs stay local and only aggregate metadata is emitted."""
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time

from compact_output import LIMIT, compact_output, expand_tap


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: benchmark_output.py TOKENIZER_DIRECTORY PUBLIC_TEST_OUTPUT [...]")
    sys.path.insert(0, sys.argv[1])
    import tiktoken
    encoder = tiktoken.get_encoding("o200k_base")
    runner = str(Path(__file__).with_name("run.py"))
    cases = []
    for index, filename in enumerate(sys.argv[2:], 1):
        raw = Path(filename).read_bytes()
        if len(raw) > LIMIT:
            raise ValueError("benchmark input exceeds limit")
        samples = []
        for _ in range(20):
            start = time.perf_counter()
            packed = compact_output(raw)
            samples.append((time.perf_counter() - start) * 1000)
        if expand_tap(packed["output"].decode()).encode() != raw:
            raise ValueError("fidelity gate failed")
        tokens_raw = len(encoder.encode(raw.decode(), disallowed_special=()))
        tokens_packed = len(encoder.encode(packed["output"].decode(), disallowed_special=()))
        direct, wrapped = [], []
        replay = ["node", "-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", str(Path(filename).resolve())]
        for repetition in range(5):
            for wrap in ([True, False] if repetition % 2 else [False, True]):
                start = time.perf_counter()
                result = subprocess.run(([sys.executable, runner, "--"] if wrap else []) + replay, capture_output=True, timeout=10)
                (wrapped if wrap else direct).append((time.perf_counter() - start) * 1000)
                if result.returncode or expand_tap(result.stdout.decode()).encode() != raw:
                    raise ValueError("replay gate failed")
        p95 = sorted(samples)[18]
        overhead = statistics.median(wrapped) - statistics.median(direct)
        cases.append(dict(case=index, source_sha256=hashlib.sha256(raw).hexdigest(), source_bytes=len(raw),
                          output_bytes=packed["output_bytes"], packed_records=packed["records"], lossless=True,
                          raw_tokens=tokens_raw, output_tokens=tokens_packed, token_reduction=round(1-tokens_packed/max(1, tokens_raw), 4),
                          processing_p95_ms=round(p95, 3), replay_direct_median_ms=round(statistics.median(direct), 3),
                          replay_wrapped_median_ms=round(statistics.median(wrapped), 3), replay_overhead_median_ms=round(overhead, 3),
                          quality_gate=True, performance_gate=p95 < 10 and overhead < 100,
                          reduction_gate=tokens_packed <= tokens_raw * (0.85 if packed["packed"] else 1)))
    report = dict(schema=1, method="lossless-node-tap-v1", execution="offline-local-only", tokenizer="o200k_base",
                  tokenizer_version=tiktoken.__version__, billed_tokens_measured=False, model_quality_measured=False,
                  inference_calls=0, token_counts_scope="text only; not Codex billing", cases=cases)
    print(json.dumps(report, indent=2))
    return 0 if all(c["quality_gate"] and c["performance_gate"] and c["reduction_gate"] for c in cases) else 1


if __name__ == "__main__":
    sys.exit(main())
