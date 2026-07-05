#!/usr/bin/env python3
"""TCP proxy to capture Moni Mobile alarm traffic for protocol discovery."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from pathlib import Path
import string


PRINTABLE = set(bytes(string.printable, "ascii")) - {0x0B, 0x0C}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Forward Moni Mobile TCP traffic while logging raw payloads. "
            "Point the mobile app at this proxy, then use the app normally."
        )
    )
    parser.add_argument("--listen-host", default="0.0.0.0")
    parser.add_argument("--listen-port", type=int, default=17000)
    parser.add_argument("--target-host", default="alarmsystem.dyndns.biz")
    parser.add_argument("--target-port", type=int, default=7000)
    parser.add_argument(
        "--log-dir",
        default=".local-secrets/moni-captures",
        help="Directory for sensitive capture logs. This repo ignores .local-secrets/.",
    )
    return parser.parse_args()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def ascii_preview(data: bytes) -> str:
    return "".join(chr(byte) if byte in PRINTABLE and byte not in b"\r\n\t" else "." for byte in data)


def format_chunk(direction: str, data: bytes) -> str:
    lines = [
        f"{utc_now()} {direction} {len(data)} bytes",
        f"hex   {data.hex(' ')}",
        f"ascii {ascii_preview(data)}",
        "",
    ]
    return "\n".join(lines)


async def pipe(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    direction: str,
    log_file: Path,
) -> None:
    try:
        while data := await reader.read(4096):
            with log_file.open("a", encoding="utf-8") as handle:
                handle.write(format_chunk(direction, data))
            writer.write(data)
            await writer.drain()
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"{utc_now()} {direction} eof\n")
        if writer.can_write_eof():
            writer.write_eof()
            await writer.drain()
        else:
            writer.close()
    except Exception as exc:
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"{utc_now()} {direction} pipe error: {exc!r}\n")
    finally:
        pass


async def handle_client(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    args: argparse.Namespace,
) -> None:
    peer = client_writer.get_extra_info("peername")
    safe_peer = f"{peer[0]}_{peer[1]}" if peer else "unknown"
    session_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    log_file = Path(args.log_dir) / f"moni_{session_id}_{safe_peer}.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)

    with log_file.open("a", encoding="utf-8") as handle:
        handle.write(
            f"{utc_now()} session start peer={peer!r} "
            f"target={args.target_host}:{args.target_port}\n\n"
        )

    try:
        target_reader, target_writer = await asyncio.open_connection(
            args.target_host,
            args.target_port,
        )
    except Exception as exc:
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"{utc_now()} target connection failed: {exc!r}\n")
        client_writer.close()
        await client_writer.wait_closed()
        return

    tasks = [
        asyncio.create_task(pipe(client_reader, target_writer, "app -> central", log_file)),
        asyncio.create_task(pipe(target_reader, client_writer, "central -> app", log_file)),
    ]

    try:
        await asyncio.gather(*tasks)
    finally:
        client_writer.close()
        target_writer.close()
        await asyncio.gather(
            client_writer.wait_closed(),
            target_writer.wait_closed(),
            return_exceptions=True,
        )
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"{utc_now()} session end\n")


async def main() -> None:
    args = parse_args()
    server = await asyncio.start_server(
        lambda reader, writer: handle_client(reader, writer, args),
        args.listen_host,
        args.listen_port,
    )

    sockets = ", ".join(str(socket.getsockname()) for socket in server.sockets or [])
    print(
        f"Listening on {sockets}; forwarding to {args.target_host}:{args.target_port}; "
        f"logs in {args.log_dir}"
    )

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
