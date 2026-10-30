"""Bounded archive extraction for the isolated recovery guest.

This module grants no host, key or transfer authority. The reviewed VM caller
must provide the finite private filesystem and password in memory. Nothing is
executed here, and no source path, credential or archive value is returned.
"""
import hashlib
import gzip
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile

CHUNK = 65536
MAX_MEMBERS = 100000
MAX_EXPANDED_BYTES = 32 * 1024**3
MAX_SELECTED_BYTES = {"compose": 256 * 1024**2, "homeassistant": 24 * 1024**3}
MAX_FILE_BYTES = {"compose": 64 * 1024**2, "homeassistant": 20 * 1024**3}
STAGING = re.compile(r"^(?:data/)?backups/(offsite-staging-[A-Za-z0-9_-]+)(?:/(.*))?$")
SEAL = ".authenticated-archive.json"
DECRYPT_BUFFER = 1024 * 1024


def require(value, reason):
    if not value:
        raise ValueError(reason)


class DecryptedReader(io.RawIOBase):
    """Adapt securetar's forward-only reader without owning its lifetime."""

    def __init__(self, source):
        self.source = source

    def readable(self):
        return True

    def readinto(self, output):
        size = min(len(output), DECRYPT_BUFFER)
        data = self.source.read(size)
        require(type(data) is bytes and len(data) <= size, "decrypted_read_limit")
        output[:len(data)] = data
        return len(data)


def drain(stream):
    trailing = 0
    while chunk := stream.read(CHUNK):
        trailing += len(chunk)
        require(trailing <= MAX_EXPANDED_BYTES, "decrypted_tail_limit")


def normalized(name):
    require(type(name) is str and 0 < len(name) <= 1024 and
            "\\" not in name and "\0" not in name, "unsafe_archive_path")
    while name.startswith("./"):
        name = name[2:]
    parts = name.rstrip("/").split("/")
    require(all(part not in ("", ".", "..") for part in parts) and
            not PurePosixPath(name).is_absolute(), "unsafe_archive_path")
    return "/".join(parts)


def copy_exact(source, output, size):
    remaining = size
    digest = hashlib.sha256()
    while remaining:
        chunk = source.read(min(CHUNK, remaining))
        require(type(chunk) is bytes and 0 < len(chunk) <= remaining,
                "archive_member_truncated")
        output.write(chunk)
        digest.update(chunk)
        remaining -= len(chunk)
    return digest.hexdigest()


def select_path(name, kind, staging_root):
    if kind == "compose":
        match = STAGING.fullmatch(name)
        if not match:
            return None, staging_root
        root, relative = match.groups()
        require(staging_root in (None, root), "multiple_staging_bundles")
        return relative or None, root
    require(kind == "homeassistant", "archive_kind_invalid")
    require(name == "data" or name.startswith("data/"), "native_root_unexpected")
    relative = name[5:] if name.startswith("data/") else None
    # Nested backups are not runtime state. Their bytes still participate in
    # the full-stream authentication and expansion limit.
    if relative == "backups" or relative and relative.startswith("backups/"):
        return None, staging_root
    return relative, staging_root


def extract_inner(stream, destination, kind):
    require(kind in MAX_SELECTED_BYTES, "archive_kind_invalid")
    destination = Path(destination)
    require(not os.path.lexists(destination), "destination_exists")
    destination.mkdir(mode=0o700)
    seen, selected = set(), set()
    staging_root = None
    count = scanned = written = files = 0
    with tarfile.open(fileobj=stream, mode="r|*") as archive:
        for member in archive:
            count += 1
            require(count <= MAX_MEMBERS, "archive_member_limit")
            if member.isdir() and member.name in (".", "./"):
                continue
            name = normalized(member.name)
            require(name not in seen, "duplicate_archive_member")
            seen.add(name)
            require(member.isfile() or member.isdir(), "archive_special_object")
            require(not member.sparse and not any("sparse" in k.lower() for k in member.pax_headers),
                    "archive_sparse_object")
            require(type(member.size) is int and member.size >= 0, "archive_size_invalid")
            scanned += member.size
            require(scanned <= MAX_EXPANDED_BYTES, "archive_expansion_limit")
            relative, staging_root = select_path(name, kind, staging_root)
            if relative is None:
                continue
            relative = normalized(relative)
            require(relative not in selected and relative != SEAL,
                    "duplicate_or_reserved_selected_member")
            selected.add(relative)
            target = destination / relative
            # All parents are exclusively inside this newly created tree, and
            # archive links/special files were rejected before any write.
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(mode=0o700, exist_ok=True)
                continue
            files += 1
            written += member.size
            require(member.size <= MAX_FILE_BYTES[kind] and written <= MAX_SELECTED_BYTES[kind],
                    "selected_archive_size_limit")
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as output:
                source = archive.extractfile(member)
                require(source is not None, "archive_member_stream_missing")
                copy_exact(source, output, member.size)
    required = ("bundle.json", "manifest.yaml", "checksums.json") if kind == "compose" else (
        "configuration.yaml", ".storage/auth", ".storage/core.config_entries",
        ".storage/core.entity_registry", ".storage/core.device_registry", "home-assistant_v2.db")
    require(all((destination / name).is_file() and not (destination / name).is_symlink()
                for name in required), "required_restored_state_missing")
    if kind == "homeassistant":
        require((destination / "home-assistant_v2.db").stat().st_size > 0,
                "restored_recorder_empty")
    return {"kind": kind, "archive_members": count, "expanded_bytes": scanned,
            "selected_files": files, "selected_bytes": written}


def extract_authenticated(backup, password, destination, kind, *, securetar_types=None):
    """Return and seal only after v3 authentication completes for the whole stream.

    Partial output on failure stays quarantined on the finite guest disk. It
    must never be executed, accepted, or automatically retried. Cleanup belongs
    to the exact reviewed VM operation, not this parser.
    """
    require(kind in MAX_SELECTED_BYTES and type(password) is str and 0 < len(password) <= 4096,
            "archive_input_invalid")
    if securetar_types is None:
        from securetar import SecureTarArchive, SecureTarHeader
    else:
        SecureTarArchive, SecureTarHeader = securetar_types
    found = False
    seen = set()
    proof = None
    with SecureTarArchive(name=backup, mode="r", password=password) as outer:
        for member in outer.tar:
            name = normalized(member.name)
            require(name not in seen and len(seen) < 3, "outer_member_limit")
            seen.add(name)
            require(member.isfile() and name in (
                "backup.json", "homeassistant.tar.gz", "homeassistant.tar", "homeassistant.tgz"),
                "outer_member_unexpected")
            if name == "backup.json":
                require(member.size <= 1048576, "outer_metadata_limit")
                continue
            require(not found, "multiple_homeassistant_archives")
            found = True
            with outer.tar.extractfile(member) as header_stream:
                header = SecureTarHeader.from_bytes(header_stream)
                require(header.version == 3 and type(header.plaintext_size) is int and
                        0 <= header.plaintext_size <= MAX_EXPANDED_BYTES,
                        "authenticated_encryption_not_proven")
            with outer.extract_tar(member) as decrypted:
                with io.BufferedReader(DecryptedReader(decrypted), DECRYPT_BUFFER) as buffered:
                    if buffered.peek(2).startswith(b"\x1f\x8b"):
                        # GzipFile limits decompression to the requested output.
                        # tarfile's streaming gzip path retains a large expanded
                        # buffer and repeatedly copies it while skipping members.
                        with gzip.GzipFile(fileobj=buffered, mode="rb") as expanded:
                            proof = extract_inner(expanded, destination, kind)
                            drain(expanded)  # Validate gzip CRC and trailer too.
                    else:
                        proof = extract_inner(buffered, destination, kind)
                    # Tar EOF is earlier than cipher EOF. Drain this same buffered
                    # reader, including prefetched bytes, to authenticate the tail.
                    drain(buffered)
    require(found and proof is not None, "homeassistant_archive_missing")
    proof.update(authenticated=True, securetar_version=3, full_ciphertext_read=True,
                 services_started=False, credentials_exported=False)
    seal = Path(destination) / SEAL
    fd = os.open(seal, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(proof, output, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return proof
