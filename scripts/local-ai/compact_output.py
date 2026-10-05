"""Lossless packing of repeated Node TAP successes; no model, network or storage."""
import hashlib
import json
import re

MARKER = "# LOCAL_CONTEXT_TAP_V1 "
LIMIT = 8 * 1024 * 1024
RECORD = re.compile(
    r"^( *)# Subtest: ([^\r\n]+)\n\1ok (\d+) - \2\n\1  ---\n"
    r"\1  duration_ms: ([0-9]+(?:\.[0-9]+)?)\n(?:\1  type: '(test)'\n)?\1  \.\.\.\n", re.M
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def expand_tap(text):
    if not text.startswith(MARKER):
        return text
    header, body = text.split("\n", 1)
    metadata = json.loads(header[len(MARKER):])
    count = 0

    def expand(match):
        nonlocal count
        indent, payload = match.groups()
        ordinal, name, duration, kind = json.loads(payload)
        if (not isinstance(ordinal, str) or not re.fullmatch(r"\d+", ordinal)
                or not isinstance(name, str) or re.search(r"[\r\n]", name)
                or not isinstance(duration, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", duration)
                or kind not in (None, "test")):
            raise ValueError("invalid packed TAP record")
        count += 1
        return (f"{indent}# Subtest: {name}\n{indent}ok {ordinal} - {name}\n{indent}  ---\n"
                f"{indent}  duration_ms: {duration}\n"
                + (f"{indent}  type: '{kind}'\n" if kind else "") + f"{indent}  ...\n")

    result = re.sub(r"^( *)@pass (.+)\n", expand, body, flags=re.M)
    raw = result.encode("utf-8")
    if count != metadata["pass_records"] or len(raw) != metadata["source_bytes"] or digest(raw) != metadata["source_sha256"]:
        raise ValueError("packed TAP integrity mismatch")
    return result


def compact_output(raw, *, min_bytes=4800, max_bytes=LIMIT, min_reduction=0.15):
    def fallback(reason):
        return dict(output=raw, packed=False, reason=reason, source_bytes=len(raw), output_bytes=len(raw), records=0)

    if len(raw) < min_bytes:
        return fallback("small_output")
    if len(raw) > max_bytes:
        return fallback("size_limit")
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError:
        return fallback("non_utf8")
    if MARKER in source or re.search(r"^ *@pass ", source, re.M):
        return fallback("marker_collision")
    count = 0

    pieces = []
    offset = 0
    yaml_indent = None
    while offset < len(source):
        match = RECORD.match(source, offset) if yaml_indent is None else None
        if match:
            indent, name, ordinal, duration, kind = match.groups()
            count += 1
            pieces.append(f"{indent}@pass {encode([ordinal, name, duration, kind])}\n")
            offset = match.end()
            continue
        end = source.find("\n", offset)
        end = len(source) if end == -1 else end + 1
        line = source[offset:end]
        plain = line.rstrip("\r\n")
        if yaml_indent is not None:
            if plain == yaml_indent + "...":
                yaml_indent = None
        else:
            opening = re.fullmatch(r"( *)---", plain)
            if opening:
                yaml_indent = opening.group(1)
        pieces.append(line)
        offset = end
    body = "".join(pieces)
    if not count:
        return fallback("no_supported_records")
    metadata = dict(columns=["id", "name", "duration_ms", "type"], pass_records=count,
                    source_bytes=len(raw), source_sha256=digest(raw))
    output = (MARKER + encode(metadata) + "\n" + body).encode("utf-8")
    # Include envelope overhead and require an exact reconstruction, not a keyword gate.
    if len(output) > len(raw) * (1 - min_reduction):
        return fallback("insufficient_reduction")
    if expand_tap(output.decode("utf-8")).encode("utf-8") != raw:
        return fallback("roundtrip_failed")
    return dict(output=output, packed=True, reason="lossless_tap", source_bytes=len(raw), output_bytes=len(output), records=count)
